import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createApp } from '../../src/bootstrap';
import { ProvisionAccountsUseCase } from '../../src/modules/treasury/application/provision-accounts.use-case';
import { RequestPayoutUseCase } from '../../src/modules/treasury/application/request-payout.use-case';
import { channel, monimeEvent } from './helpers';

let app: INestApplication;
let http: ReturnType<typeof request>;
const prisma = new PrismaClient();
const admin = { id: 'e2e-admin', permissions: ['payouts.manage'] };

beforeAll(async () => {
  app = await createApp();
  http = request(app.getHttpServer());
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/** Pays a student's tuition instalment end to end; returns the payment id. */
async function payTuition(studentId: string, phone: string, amount: string, key: string): Promise<string> {
  const ob = await channel(http, 'get', `/v1/channel/payers/student/${studentId}/obligations`).expect(200);
  const tuition = ob.body.obligations.find((o: { feeTypeCode: string }) => o.feeTypeCode === 'TUITION');
  const pay = await channel(http, 'post', '/v1/channel/payments', { obligationId: tuition.id, amount, payerPhone: phone, channel: 'USSD', idempotencyKey: key }).expect(201);
  const sim = await http.post('/dev/monime/simulate-webhook').send({ paymentId: pay.body.paymentId, outcome: 'completed' }).expect(200);
  expect(sim.body.ack.result).toBe('PROCESSED');
  return pay.body.paymentId;
}

describe('financial accounts', () => {
  it('provisions one Monime account per fee type plus the platform account, idempotently', async () => {
    const first = await app.get(ProvisionAccountsUseCase).execute();
    expect(first.map((a) => [a.reference, a.purpose])).toEqual(
      expect.arrayContaining([
        ['unimak-fee-app', 'FEE_TYPE'], ['unimak-fee-tuition', 'FEE_TYPE'], ['unimak-fee-matric', 'FEE_TYPE'],
        ['unimak-fee-dept', 'FEE_TYPE'], ['unimak-fee-grad', 'FEE_TYPE'], ['unimak-platform', 'PLATFORM'],
      ]),
    );
    const again = await app.get(ProvisionAccountsUseCase).execute();
    expect(again.every((a) => !a.created)).toBe(true);
    expect(await prisma.financialAccount.count()).toBe((await prisma.feeType.count()) + 1); // one per fee type + platform
  });

  it('collects into the fee type’s own account (payment code)', async () => {
    const paymentId = await payTuition('UNI-2026-0001', '+23276200001', '200000', 'tr-tui-0001');
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const code = await prisma.mockMonimeRecord.findUniqueOrThrow({ where: { id: p.monimeRef! } });
    expect(code).toMatchObject({ kind: 'PAYMENT_CODE', status: 'completed' });
    expect((code.data as Record<string, unknown>)['financialAccountId']).toBe('fac-mock-unimak-fee-tuition');
  });
});

describe('commission internal transfers', () => {
  it('moves the commission to the platform account and completes on internal_transfer.completed', async () => {
    const paymentId = await payTuition('UNI-2025-0002', '+23277200002', '150000', 'tr-tui-0002');
    const t = await prisma.transfer.findUniqueOrThrow({ where: { paymentId } });
    // USSD 1.5% platform share of SLE 1,500 = SLE 22.50
    expect(t).toMatchObject({ status: 'SUBMITTED', amount: 2_250n, sourceAccount: 'fac-mock-unimak-fee-tuition', destinationAccount: 'fac-mock-unimak-platform' });

    const sim = await http.post('/dev/monime/simulate-webhook').send({ transferId: t.id, outcome: 'completed', eventId: 'wke-trn-1' }).expect(200);
    expect(sim.body.ack).toMatchObject({ result: 'PROCESSED', eventId: 'wke-trn-1' });
    expect(await prisma.transfer.findUnique({ where: { id: t.id } })).toMatchObject({ status: 'COMPLETED', completedAt: expect.any(Date) });

    const dup = await http.post('/dev/monime/simulate-webhook').send({ transferId: t.id, outcome: 'completed', eventId: 'wke-trn-1' }).expect(200);
    expect(dup.body.ack.result).toBe('DUPLICATE');
  });

  it('records internal_transfer.failed with the failure code', async () => {
    const paymentId = await payTuition('UNI-2025-0003', '+23278200003', '200000', 'tr-tui-0003');
    const t = await prisma.transfer.findUniqueOrThrow({ where: { paymentId } });
    await http.post('/dev/monime/simulate-webhook').send({ transferId: t.id, outcome: 'failed' }).expect(200);
    expect(await prisma.transfer.findUnique({ where: { id: t.id } })).toMatchObject({ status: 'FAILED', failureCode: 'fund_insufficient' });
  });
});

describe('payouts to a bank account', () => {
  it('refuses more than the available balance', async () => {
    await expect(
      app.get(RequestPayoutUseCase).execute(admin, {
        account: 'unimak-fee-tuition', amount: 100_000_000n, bankProviderId: 'slb001', accountNumber: '0011223344', idempotencyKey: 'po-too-much',
      }),
    ).rejects.toMatchObject({ code: 'AMOUNT_EXCEEDS_PAYABLE' });
  });

  it('needs payouts.manage and a payout-capable bank', async () => {
    const input = { account: 'unimak-fee-tuition', amount: 1_000n, bankProviderId: 'slb001', accountNumber: '0011223344', idempotencyKey: 'po-perm' };
    await expect(app.get(RequestPayoutUseCase).execute({ id: 'x', permissions: [] }, input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(app.get(RequestPayoutUseCase).execute(admin, { ...input, bankProviderId: 'slb999' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('withdraws to a bank account, completes on payout.completed with fees', async () => {
    const payouts = app.get(RequestPayoutUseCase);
    const input = { account: 'unimak-fee-tuition', amount: 100_000n, bankProviderId: 'slb001', accountNumber: '0011223344', accountName: 'University of Makeni', narration: 'Tuition sweep', idempotencyKey: 'po-1' };
    const p = await payouts.execute(admin, input);
    expect(p).toMatchObject({ status: 'SUBMITTED', monimePayoutId: 'pyt-mock-' + p.id.slice(0, 55) });
    expect((await payouts.execute(admin, input)).id).toBe(p.id); // idempotent replay

    const remote = await prisma.mockMonimeRecord.findUniqueOrThrow({ where: { id: p.monimePayoutId! } });
    expect(remote.data).toMatchObject({ sourceFinancialAccountId: 'fac-mock-unimak-fee-tuition', destination: { type: 'bank', providerId: 'slb001', accountNumber: '0011223344' } });

    const sim = await http.post('/dev/monime/simulate-webhook').send({ payoutId: p.id, outcome: 'completed' }).expect(200);
    expect(sim.body.ack.result).toBe('PROCESSED');
    expect(await prisma.payout.findUnique({ where: { id: p.id } })).toMatchObject({ status: 'COMPLETED', fees: 500n });
  });

  it('records payout.failed', async () => {
    const p = await app.get(RequestPayoutUseCase).execute(admin, {
      account: 'unimak-fee-tuition', amount: 10_000n, bankProviderId: 'slb004', accountNumber: '9988776655', idempotencyKey: 'po-2',
    });
    await http.post('/dev/monime/simulate-webhook').send({ payoutId: p.id, outcome: 'failed' }).expect(200);
    expect(await prisma.payout.findUnique({ where: { id: p.id } })).toMatchObject({ status: 'FAILED', failureCode: 'provider_account_missing' });
    // a late payout.completed for a failed payout is not applied
    const late = await monimeEvent(http, 'payout.completed', { id: p.monimePayoutId, type: 'payout' }, { id: p.monimePayoutId, status: 'completed', amount: { currency: 'SLE', value: 10000 } }).expect(200);
    expect(late.body).toMatchObject({ result: 'UNMATCHED', note: 'payout.completed while payout is FAILED' });
  });
});

describe('financial_account.credited / debited', () => {
  it('updates the cached balance of our account, ignores others', async () => {
    const res = await monimeEvent(http, 'financial_account.credited', { id: 'txn-1', type: 'financial_transaction' }, {
      id: 'txn-1', type: 'credit', amount: { currency: 'SLE', value: 5000 },
      financialAccount: { id: 'fac-mock-unimak-fee-app', balance: { after: { currency: 'SLE', value: 123456 } } },
    }).expect(200);
    expect(res.body.result).toBe('PROCESSED');
    expect(await prisma.financialAccount.findUnique({ where: { monimeId: 'fac-mock-unimak-fee-app' } })).toMatchObject({ availableBalance: 123456n });

    const other = await monimeEvent(http, 'financial_account.debited', { id: 'fac-someone-else', type: 'financial_account' }, { id: 'fac-someone-else' }).expect(200);
    expect(other.body.result).toBe('IGNORED');
  });
});
