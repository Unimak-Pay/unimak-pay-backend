import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createApp } from '../../src/bootstrap';
import { MockMonimeClient } from '../../src/modules/integrations/monime/mock-monime.client';
import { MONIME_CLIENT } from '../../src/modules/integrations/monime/monime.port';
import { NightlyReconciliationService } from '../../src/modules/reconciliation/application/nightly-reconciliation.service';
import { ProvisionAccountsUseCase } from '../../src/modules/treasury/application/provision-accounts.use-case';
import { adminToken, channel, monimeEvent } from './helpers';

let app: INestApplication;
let http: ReturnType<typeof request>;
let recon: NightlyReconciliationService;
let mock: MockMonimeClient;
const prisma = new PrismaClient();
const HOUR = 60 * 60_000;
const window = () => ({ start: new Date(Date.now() - HOUR), end: new Date(Date.now() + HOUR) });

async function startPayment(ref: string, feeType: string, amount: string, key: string): Promise<string> {
  const ob = await channel(http, 'get', `/v1/channel/payers/student/${ref}/obligations`).expect(200);
  const o = ob.body.obligations.find((x: { feeTypeCode: string }) => x.feeTypeCode === feeType);
  const res = await channel(http, 'post', '/v1/channel/payments', { obligationId: o.id, amount, payerPhone: '+23276555555', channel: 'USSD', idempotencyKey: key }).expect(201);
  return res.body.paymentId;
}
const simulate = (body: object) => http.post('/dev/monime/simulate-webhook').send(body).expect(200);
const itemsFor = async (runId: string, ids: { paymentId?: string; monimePaymentId?: string }) =>
  prisma.reconciliationItem.findMany({ where: { runId, ...ids } });

beforeAll(async () => {
  app = await createApp();
  http = request(app.getHttpServer());
  await app.get(ProvisionAccountsUseCase).execute();
  recon = app.get(NightlyReconciliationService);
  mock = app.get(MONIME_CLIENT);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('nightly reconciliation against Monime', () => {
  let clean: string;
  let missed: string;
  let noMonime: string;
  let feeOff: string;
  const strayId = `pay-stray-${randomUUID().slice(0, 8)}`;
  let runId: string;

  beforeAll(async () => {
    // 1. normal payment, commission transfer completed → nothing to report
    clean = await startPayment('UNI-2025-0002', 'DEPT', '30000', 'recon-clean-1');
    await simulate({ paymentId: clean, outcome: 'completed' });
    const t = await prisma.transfer.findUniqueOrThrow({ where: { paymentId: clean } });
    await simulate({ transferId: t.id, outcome: 'completed' });

    // 2. Monime collected but the webhook never arrived
    missed = await startPayment('UNI-2025-0003', 'DEPT', '30000', 'recon-missed-1');
    await simulate({ paymentId: missed, outcome: 'completed', deliver: false });

    // 3. a payment into our account that we know nothing about
    const tuition = await prisma.financialAccount.findUniqueOrThrow({ where: { reference: 'unimak-fee-tuition' } });
    await mock.recordPayment({ id: strayId, amount: 77_700n, financialAccountId: tuition.monimeId, reference: 'someone-else', metadata: {}, ownerId: null, fees: 0n, payerPhone: null });

    // 4. completed on our side but Monime has no such payment (commission never transferred either)
    noMonime = await startPayment('UNI-2023-0004', 'DEPT', '30000', 'recon-nomonime-1');
    await monimeEvent(http, 'payment.processing_completed', { id: 'pay-ghost', type: 'payment' }, {
      id: 'pay-ghost', status: 'completed', amount: { currency: 'SLE', value: 30000 }, reference: noMonime,
      fees: [{ code: 'processing', amount: { currency: 'SLE', value: 300 } }],
    }).expect(200);

    // 5. Monime's fee differs from our pricing
    feeOff = await startPayment('UNI-2025-0009', 'DEPT', '30000', 'recon-fee-1');
    const sim = await simulate({ paymentId: feeOff, outcome: 'completed' });
    await prisma.mockMonimeRecord.update({ where: { id: sim.body.ack ? sim.body.event.data.id : '' }, data: { data: { ...(await prisma.mockMonimeRecord.findUniqueOrThrow({ where: { id: sim.body.event.data.id } })).data as object, fees: '999' } } });
    const ft = await prisma.transfer.findUniqueOrThrow({ where: { paymentId: feeOff } });
    await simulate({ transferId: ft.id, outcome: 'completed' });

    const { start, end } = window();
    const run = await recon.run(start, end, 'e2e');
    expect(run.status).toBe('COMPLETED');
    runId = run.id;
  });

  it('reports nothing for a payment that matches end to end', async () => {
    expect(await itemsFor(runId, { paymentId: clean })).toEqual([]);
  });

  it('auto-settles a missed webhook through the normal settlement step', async () => {
    const [item] = await itemsFor(runId, { paymentId: missed });
    expect(item).toMatchObject({ kind: 'MISSED_WEBHOOK_SETTLED', status: 'AUTO_RESOLVED', note: expect.stringMatching(/^Webhook never arrived; settled from Monime \(receipt UNIMAK-/) });
    expect(await prisma.payment.findUnique({ where: { id: missed } })).toMatchObject({ status: 'COMPLETED', monimePaymentId: `pay-mock-${missed.slice(0, 8)}` });
    expect(await prisma.receipt.count({ where: { paymentId: missed } })).toBe(1);
    expect(await prisma.ledgerEntry.count({ where: { paymentId: missed } })).toBe(1);
  });

  it('flags Monime payments we cannot match', async () => {
    const [item] = await itemsFor(runId, { monimePaymentId: strayId });
    expect(item).toMatchObject({ kind: 'UNMATCHED_MONIME_PAYMENT', status: 'OPEN', note: 'Not a UNIMAK payment', actual: { amount: '77700', reference: 'someone-else' } });
  });

  it('flags our completed payments that Monime does not have, and their missing commission', async () => {
    const items = await itemsFor(runId, { paymentId: noMonime });
    expect(items.map((i) => i.kind).sort()).toEqual(['COMMISSION_NOT_COMPLETED', 'MISSING_AT_MONIME']);
    expect(items.find((i) => i.kind === 'MISSING_AT_MONIME')).toMatchObject({ monimePaymentId: 'pay-ghost', note: 'Monime has no such payment' });
    expect(items.find((i) => i.kind === 'COMMISSION_NOT_COMPLETED')?.note).toBe('Commission transfer is SUBMITTED');
  });

  it('flags Monime fee differences', async () => {
    const [item] = await itemsFor(runId, { paymentId: feeOff });
    expect(item).toMatchObject({ kind: 'MONIME_FEE_MISMATCH', expected: { monimeFee: '300' }, actual: { monimeFee: '999' } });
  });

  it('re-running the window does not duplicate open items', async () => {
    const others = { status: 'OPEN' as const, NOT: { paymentId: missed } };
    const before = await prisma.reconciliationItem.count({ where: others });
    const { start, end } = window();
    const again = await recon.run(start, end, 'e2e');
    expect(await prisma.reconciliationItem.count({ where: others })).toBe(before);
    expect(again.stats).toMatchObject({ autoSettled: 0 });
    // the payment settled by the first run is now checked normally: its commission is still in flight
    expect((await itemsFor(again.id, { paymentId: missed })).map((i) => i.kind)).toEqual(['COMMISSION_NOT_COMPLETED']);
  });

  it('admins see open items, resolve them, and can run a day on demand', async () => {
    const email = `bursar-${randomUUID().slice(0, 6)}@unimak.test`;
    await prisma.adminUser.create({ data: { email, role: 'BURSAR' } });
    const token = adminToken({ sub: randomUUID(), email, aal: 'aal2' });
    const auth = (r: request.Test) => r.set('authorization', `Bearer ${token}`);

    const summary = await auth(http.get('/v1/admin/reconciliation')).expect(200);
    const stray = summary.body.openItems.find((i: { monimePaymentId: string }) => i.monimePaymentId === strayId);
    expect(stray).toBeTruthy();
    expect(summary.body.lastRun.status).toBe('COMPLETED');

    await auth(http.post(`/v1/admin/reconciliation/items/${stray.id}/resolve`)).send({ resolution: 'Payment for another merchant, refunded by Monime' }).expect(200);
    await auth(http.post(`/v1/admin/reconciliation/items/${stray.id}/resolve`)).send({ resolution: 'again' }).expect(409);

    const yesterday = NightlyReconciliationService.previousDay().start.toISOString().slice(0, 10);
    const run = await auth(http.post('/v1/admin/reconciliation/runs')).send({ date: yesterday }).expect(201);
    expect(run.body).toMatchObject({ status: 'COMPLETED', triggeredBy: expect.any(String), items: expect.any(Array) });
    await auth(http.post('/v1/admin/reconciliation/runs')).send({ date: '2999-01-01' }).expect(400);
    const runs = await auth(http.get('/v1/admin/reconciliation/runs')).expect(200);
    expect(runs.body.items.length).toBeGreaterThanOrEqual(3);
    expect(await prisma.auditLog.count({ where: { action: 'reconciliation.run' } })).toBeGreaterThanOrEqual(1);
  });

  it('nightly cron reconciles yesterday once', async () => {
    const cron = () => http.get('/cron/reconcile').set('authorization', `Bearer ${process.env.CRON_SECRET}`).expect(200);
    const first = await cron();
    const second = await cron();
    expect(second.body).toEqual({ skipped: true, runId: expect.any(String) });
    expect(first.body.id ?? first.body.runId).toBeTruthy();
  });
});
