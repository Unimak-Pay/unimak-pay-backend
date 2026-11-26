import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createApp } from '../../src/bootstrap';
import { ProvisionAccountsUseCase } from '../../src/modules/treasury/application/provision-accounts.use-case';
import { signMonimePayload } from '../../src/modules/webhooks/domain/monime-signature';
import { channel as signedChannel } from './helpers';
import { TEST_CLIENT, TEST_CRON_SECRET, TEST_WEBHOOK_SECRET } from './test-env';

let app: INestApplication;
let http: ReturnType<typeof request>;
const prisma = new PrismaClient();

const channel = (method: 'get' | 'post', url: string, body?: object) => signedChannel(http, method, url, body);

beforeAll(async () => {
  app = await createApp();
  http = request(app.getHttpServer());
  await app.get(ProvisionAccountsUseCase).execute(); // one Monime account per fee type + platform
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('channel API happy path: lookup → initiate → webhook → receipt + outbox', () => {
  const ref = 'APP-2026-0004'; // international applicant → SLE 500 application fee
  let obligationId: string;
  let paymentId: string;

  it('looks up the payer (masked) and lazily creates the obligation', async () => {
    const res = await channel('get', `/v1/channel/payers/applicant/${ref}`).expect(200);
    expect(res.body).toEqual({
      kind: 'applicant', ref, maskedName: 'K*** M***', programLine: 'BSC-CS · Applicant 2026-SEP', stale: false,
    });

    const ob = await channel('get', `/v1/channel/payers/applicant/${ref}/obligations`).expect(200);
    expect(ob.body.obligations).toHaveLength(1);
    const o = ob.body.obligations[0];
    expect(o).toMatchObject({
      feeTypeCode: 'APP',
      amount: { value: '50000' }, paid: { value: '0' }, balance: { value: '50000' },
      holds: { value: '0' }, payable: { value: '50000' }, minInstalment: { value: '50000' },
      dueDate: '2026-08-31', status: 'OPEN',
    });
    obligationId = o.id;

    // lookup again: no duplicate obligation / CHARGE
    await channel('get', `/v1/channel/payers/applicant/${ref}`).expect(200);
    expect(await prisma.ledgerEntry.count({ where: { obligationId } })).toBe(1);
  });

  it('initiates a payment (PENDING, no expiry: deleted after 7 days if unpaid); it holds only once Monime is processing it', async () => {
    const body = { obligationId, amount: '50000', payerPhone: '+23299100004', channel: 'USSD', idempotencyKey: 'e2e-app-0004-1' };
    const res = await channel('post', '/v1/channel/payments', body).expect(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.paymentRef).toMatch(/^[1-9]\d{7}$/);
    expect(res.body.ussdCode).toMatch(/^\*715\*1\*\d+#$/);
    const days = (new Date(res.body.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);
    paymentId = res.body.paymentId;

    const replay = await channel('post', '/v1/channel/payments', body).expect(201);
    expect(replay.body.paymentId).toBe(paymentId);

    const ob = await channel('get', `/v1/channel/payers/applicant/${ref}/obligations`).expect(200);
    expect(ob.body.obligations[0]).toMatchObject({ holds: { value: '0' }, payable: { value: '50000' } });

    // payment.processing_started: PROCESSING, and now it holds the amount
    const started = await http.post('/dev/monime/simulate-webhook').send({ paymentId, outcome: 'processing' }).expect(200);
    expect(started.body.ack).toMatchObject({ result: 'PROCESSED' });
    expect((await channel('get', `/v1/channel/payments/${paymentId}`).expect(200)).body.status).toBe('PROCESSING');
    const held = await channel('get', `/v1/channel/payers/applicant/${ref}/obligations`).expect(200);
    expect(held.body.obligations[0]).toMatchObject({ holds: { value: '50000' }, payable: { value: '0' } });

    const p = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    // USSD: total 2.5% = 1250, Monime 1% = 500, platform 750
    expect({ m: p.monimeFee, pl: p.platformFee, n: p.netAmount }).toEqual({ m: 500n, pl: 750n, n: 48_750n });
  });

  it('settles via the simulated Monime webhook (and dedupes redelivery)', async () => {
    const sim = await http
      .post('/dev/monime/simulate-webhook')
      .send({ paymentId, outcome: 'completed', eventId: 'evt-e2e-1' })
      .expect(200);
    expect(sim.body.ack).toEqual({ received: true, eventId: 'evt-e2e-1', result: 'PROCESSED' });

    const again = await http.post('/dev/monime/simulate-webhook').send({ paymentId, outcome: 'completed', eventId: 'evt-e2e-1' }).expect(200);
    expect(again.body.ack.result).toBe('DUPLICATE');

    const pay = await channel('get', `/v1/channel/payments/${paymentId}`).expect(200);
    expect(pay.body).toMatchObject({ status: 'COMPLETED', amount: { value: '50000' }, monimeOrderNumber: `MO${pay.body.paymentRef}` });
    // Monime reports the payer masked; the authorised code's metadata carries the full number
    expect(await prisma.payment.findUnique({ where: { id: paymentId } })).toMatchObject({ payerPhone: '+23299100004' });

    const ob = await channel('get', `/v1/channel/payers/applicant/${ref}/obligations`).expect(200);
    expect(ob.body.obligations[0]).toMatchObject({ status: 'PAID', paid: { value: '50000' }, balance: { value: '0' }, holds: { value: '0' } });
    expect(await prisma.ledgerEntry.count({ where: { paymentId } })).toBe(1);
  });

  it('issues a receipt that verifies publicly', async () => {
    const res = await channel('get', `/v1/channel/payers/applicant/${ref}/receipts`).expect(200);
    expect(res.body.receipts).toHaveLength(1);
    expect(res.body.receipts[0]).toMatchObject({ number: expect.stringMatching(/^UNIMAK-\d{4}-\d{6}$/), amount: { value: '50000' }, paymentId });

    const receipt = await prisma.receipt.findUniqueOrThrow({ where: { paymentId } });
    const page = await http.get(`/r/${receipt.verifyCode}`).expect(200);
    expect(page.text).toContain('Valid UNIMAK receipt');
    expect(page.text).toContain('SLE 500.00');
    expect(page.text).toContain('K*** M***');
    await http.get('/r/ZZZZZZZZZZ').expect(404);
  });

  it('payment status by our ref or Monime order number', async () => {
    const { paymentRef } = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const receipt = await prisma.receipt.findUniqueOrThrow({ where: { paymentId } });
    const expected = {
      paymentRef, monimeOrderNumber: `MO${paymentRef}`, status: 'COMPLETED', amount: { value: '50000', display: 'SLE 500.00' },
      feeName: 'Application fee 2026-SEP', payer: { kind: 'applicant', ref, maskedName: 'K*** M***' }, receiptNumber: receipt.number,
    };
    expect((await channel('get', `/v1/channel/payments/status/${paymentRef}`).expect(200)).body).toMatchObject(expected);
    expect((await channel('get', `/v1/channel/payments/status/mo${paymentRef}`).expect(200)).body).toMatchObject(expected);
    expect((await channel('get', '/v1/channel/payments/status/12345678').expect(404)).body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Payment not found' });
    await channel('get', '/v1/channel/payments/status/not-a-ref!').expect(404);
  });

  it('writes and delivers the outbox messages (no SMS: Monime texts the payer)', async () => {
    const rows = await prisma.outboxMessage.findMany({ where: { dedupeKey: { endsWith: paymentId } }, orderBy: { type: 'asc' } });
    expect(rows.map((r) => [r.type, r.status])).toEqual([
      ['monime.commission_transfer', 'SENT'],
      ['portal.application_paid', 'SENT'],
    ]);
    expect(rows[0]!.payload).toEqual({ paymentId, fromAccount: 'fac-mock-unimak-fee-app', amount: '750' });
    // commission → internal transfer from the APP account to the platform account
    const transfer = await prisma.transfer.findUniqueOrThrow({ where: { paymentId } });
    expect(transfer).toMatchObject({
      kind: 'COMMISSION', amount: 750n, status: 'SUBMITTED',
      sourceAccount: 'fac-mock-unimak-fee-app', destinationAccount: 'fac-mock-unimak-platform',
      monimeTransferId: `trn-mock-commission-${paymentId}`.slice(0, 64),
    });

    const log = JSON.parse(readFileSync(path.join(process.env.PORTAL_FIXTURES_DIR!, 'notifications.log.json'), 'utf8')) as { payload: Record<string, string> }[];
    expect(log.at(-1)!.payload).toMatchObject({ event: 'application_paid', applicationRef: ref, amount: '50000' });

  });

  it('refuses a second application-fee payment', async () => {
    const res = await channel('post', '/v1/channel/payments', {
      obligationId, amount: '50000', payerPhone: '+23299100004', channel: 'USSD', idempotencyKey: 'e2e-app-0004-2',
    }).expect(409);
    expect(res.body.error.code).toBe('OBLIGATION_SETTLED');
  });
});

describe('POST /webhooks/monime (signed, as Monime sends it)', () => {
  it('settles a tuition instalment from a raw signed delivery', async () => {
    const ob = await channel('get', '/v1/channel/payers/student/UNI-2024-0006/obligations').expect(200);
    const tuition = ob.body.obligations.find((o: { feeTypeCode: string }) => o.feeTypeCode === 'TUITION');
    expect(tuition).toMatchObject({ amount: { value: '750000' }, minInstalment: { value: '200000' } }); // BSC-NUR L3 local, NUR min 2,000

    const pay = await channel('post', '/v1/channel/payments', {
      obligationId: tuition.id, amount: '200000', payerPhone: '+23233200006', channel: 'DOTS', idempotencyKey: 'e2e-tui-0006-1',
    }).expect(201);
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: pay.body.paymentId } });

    const event = {
      apiVersion: 'caph.2025-08-23',
      event: { id: 'evt-e2e-raw-1', name: 'payment.processing_completed', timestamp: new Date().toISOString() },
      object: { id: 'spm-e2e-raw-1', type: 'payment' },
      data: {
        id: 'spm-e2e-raw-1', status: 'completed', amount: { currency: 'SLE', value: 200000 },
        financialAccountId: 'fac-mock-unimak-fee-tuition', reference: p.id,
        fees: [{ code: 'processing', amount: { currency: 'SLE', value: 50 } }],
        ownershipGraph: { owner: { id: p.monimeRef, type: 'payment_code' } },
      },
    };
    const raw = JSON.stringify(event);
    const header = signMonimePayload(raw, TEST_WEBHOOK_SECRET, String(Math.floor(Date.now() / 1000)));

    await http.post('/webhooks/monime').set('content-type', 'application/json').set('Monime-Signature', header.replace(/v1=./, 'v1=X')).send(raw).expect(401);
    const res = await http.post('/webhooks/monime').set('content-type', 'application/json').set('Monime-Signature', header).send(raw).expect(200);
    expect(res.body).toEqual({ received: true, eventId: 'evt-e2e-raw-1', result: 'PROCESSED' });

    const after = await channel('get', '/v1/channel/payers/student/UNI-2024-0006/obligations').expect(200);
    expect(after.body.obligations.find((o: { id: string }) => o.id === tuition.id)).toMatchObject({
      status: 'OPEN', paid: { value: '200000' }, balance: { value: '550000' }, payable: { value: '550000' },
    });
    // DOTS: total 5,000, Monime 50, platform 4,950
    expect(await prisma.payment.findUnique({ where: { id: p.id } })).toMatchObject({ status: 'COMPLETED', monimeFee: 50n, platformFee: 4_950n, monimePaymentId: 'spm-e2e-raw-1' });
  });

  it('acknowledges an amount mismatch as UNMATCHED without settling', async () => {
    const ob = await channel('get', '/v1/channel/payers/student/UNI-2026-0001/obligations').expect(200);
    const dept = ob.body.obligations.find((o: { feeTypeCode: string }) => o.feeTypeCode === 'DEPT');
    const pay = await channel('post', '/v1/channel/payments', {
      obligationId: dept.id, amount: '30000', payerPhone: '+23276200001', channel: 'USSD', idempotencyKey: 'e2e-dept-0001',
    }).expect(201);
    const sim = await http.post('/dev/monime/simulate-webhook').send({ paymentId: pay.body.paymentId, outcome: 'completed', amount: '29999' }).expect(200);
    expect(sim.body.ack).toMatchObject({ result: 'UNMATCHED', note: 'Monime collected 29999, payment was for 30000' });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pay.body.paymentId } })).status).toBe('PENDING');
  });

  it('ignores events it does not handle', async () => {
    const raw = JSON.stringify({ event: { id: 'evt-e2e-other', name: 'checkout_session.completed' }, object: {}, data: {} });
    const header = signMonimePayload(raw, TEST_WEBHOOK_SECRET, String(Math.floor(Date.now() / 1000)));
    const res = await http.post('/webhooks/monime').set('content-type', 'application/json').set('Monime-Signature', header).send(raw).expect(200);
    expect(res.body.result).toBe('IGNORED');
  });
});

describe('auth and cron', () => {
  it('rejects bad channel signatures and stale timestamps', async () => {
    await http.get('/v1/channel/payers/student/UNI-2026-0001').expect(401);
    const ts = String(Math.floor(Date.now() / 1000) - 400);
    const sig = createHmac('sha256', TEST_CLIENT.secret).update(`${ts}.`).digest('hex');
    await http.get('/v1/channel/payers/student/UNI-2026-0001').set('x-api-key', TEST_CLIENT.apiKey).set('x-timestamp', ts).set('x-signature', sig).expect(401);
  });

  it('protects cron routes with CRON_SECRET', async () => {
    await http.get('/cron/outbox').expect(401);
    const res = await http.get('/cron/outbox').set('authorization', `Bearer ${TEST_CRON_SECRET}`).expect(200);
    expect(res.body).toMatchObject({ claimed: expect.any(Number) });
    await http.get('/cron/expire-payments').set('authorization', `Bearer ${TEST_CRON_SECRET}`).expect(200);
  });
});
