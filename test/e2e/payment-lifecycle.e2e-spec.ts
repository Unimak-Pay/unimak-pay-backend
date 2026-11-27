import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createApp } from '../../src/bootstrap';
import { ProvisionAccountsUseCase } from '../../src/modules/treasury/application/provision-accounts.use-case';
import { monimeEvent, portal } from './helpers';
import { TEST_CRON_SECRET } from './test-env';

/** docs/payment-lifecycle.md: PENDING never expires; PROCESSING from Monime; cleanup deletes unpaid ones. */
let app: INestApplication;
let http: ReturnType<typeof request>;
const prisma = new PrismaClient();

const REF = 'UNI-2026-0601';
let ipSeq = 0;
const ip = () => `10.66.0.${++ipSeq}`;
let seq = 0;
const pay = async (amount: string) =>
  (await http.post('/v1/dot/payments').set('x-real-ip', ip()).set('Idempotency-Key', `life-${Date.now()}-${++seq}`).send({ obligationId, amount }).expect(201)).body;
const statusOf = async (id: string) => (await prisma.payment.findUnique({ where: { id } }))?.status ?? 'DELETED';
const holds = async () =>
  (await http.get(`/v1/dot/payers/student/${REF}`).set('x-real-ip', ip()).expect(200)).body.obligations.find((o: { id: string }) => o.id === obligationId).holds.value;
const simulate = (paymentId: string, outcome: 'processing' | 'completed') => http.post('/dev/monime/simulate-webhook').send({ paymentId, outcome }).expect(200);
const cron = () => http.get('/cron/expire-payments').set('authorization', `Bearer ${TEST_CRON_SECRET}`).expect(200);
let obligationId: string;

beforeAll(async () => {
  app = await createApp();
  http = request(app.getHttpServer());
  await app.get(ProvisionAccountsUseCase).execute();
  await portal(http, 'post', '/v1/portal/events', { events: [{
    id: `evt-life-${Date.now()}`, type: 'student.upserted', occurredAt: '2026-11-28T09:00:00Z',
    data: { studentId: REF, applicationRef: null, fullName: 'Life Cycle', phone: '+23276600601', programCode: 'BSC-CS', department: 'COMPUTER-SCI', level: 1, finalYear: false, residency: 'LOCAL', intake: '2026-SEP', enrolmentStatus: 'ACTIVE', updatedAt: '2026-11-28T09:00:00.000Z' },
  }] }).expect(200);
  obligationId = (await prisma.obligation.findFirstOrThrow({ where: { payer: { ref: REF }, fee: { feeType: { code: 'TUITION' } } } })).id;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('payment lifecycle', () => {
  it('PENDING → PROCESSING (holds) → COMPLETED; a late processing_started changes nothing', async () => {
    const p = await pay('150000');
    expect(p.status).toBe('PENDING');
    expect(await holds()).toBe('0');
    const started = await simulate(p.paymentId, 'processing');
    expect(started.body.ack.result).toBe('PROCESSED');
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: p.paymentId } })).toMatchObject({ status: 'PROCESSING', processingAt: expect.any(Date), monimeChannelType: 'momo' });
    expect(await holds()).toBe('150000');
    // a second payment can't take the fee over its balance while Monime is processing the first
    const status = (await http.get(`/v1/dot/payments/status/${p.paymentRef}`).set('x-real-ip', ip()).expect(200)).body;
    expect(status.status).toBe('PROCESSING');

    await simulate(p.paymentId, 'completed');
    expect(await statusOf(p.paymentId)).toBe('COMPLETED');
    const late = await simulate(p.paymentId, 'processing');
    expect(late.body.ack).toMatchObject({ result: 'PROCESSED', note: expect.stringContaining('Already completed') });
    expect(await statusOf(p.paymentId)).toBe('COMPLETED');
  });

  it('processing_started for a different amount is flagged, not applied', async () => {
    const p = await pay('150000');
    const res = await monimeEvent(http, 'payment.processing_started', { id: 'pay-life-x', type: 'payment' }, {
      id: 'pay-life-x', status: 'processing', amount: { currency: 'SLE', value: 999 }, reference: p.paymentId, metadata: { paymentId: p.paymentId },
    }).expect(200);
    expect(res.body).toMatchObject({ result: 'UNMATCHED', note: expect.stringContaining('payment is for SLE 150000') });
    expect(await statusOf(p.paymentId)).toBe('PENDING');
  });

  it('PROCESSING with nothing from Monime for 24 h goes back to PENDING and stops holding', async () => {
    const p = await pay('150000');
    await simulate(p.paymentId, 'processing');
    await prisma.payment.update({ where: { id: p.paymentId }, data: { processingAt: new Date(Date.now() - 23 * 3_600_000) } });
    expect(await holds()).toBe('150000');
    await prisma.payment.update({ where: { id: p.paymentId }, data: { processingAt: new Date(Date.now() - 25 * 3_600_000) } });
    expect(await holds()).toBe('0'); // stops holding at 24 h even before the cleanup runs
    const res = await cron();
    expect(res.body.processingReset).toBeGreaterThanOrEqual(1);
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: p.paymentId } })).toMatchObject({ status: 'PENDING', processingAt: null });
  });

  it('the cleanup deletes payments still awaiting payment after 7 days, and nothing else (audited)', async () => {
    const old = await pay('150000');
    const recent = await pay('150000');
    const processing = await pay('150000');
    await simulate(processing.paymentId, 'processing');
    const ago = (d: number) => new Date(Date.now() - d * 86_400_000);
    await prisma.payment.update({ where: { id: old.paymentId }, data: { createdAt: ago(8) } });
    await prisma.payment.update({ where: { id: recent.paymentId }, data: { createdAt: ago(6) } });
    await prisma.payment.update({ where: { id: processing.paymentId }, data: { createdAt: ago(8) } });

    const res = await cron();
    expect(res.body.pendingDeleted).toBeGreaterThanOrEqual(1);
    expect(await statusOf(old.paymentId)).toBe('DELETED');
    expect(await statusOf(recent.paymentId)).toBe('PENDING');
    expect(await statusOf(processing.paymentId)).toBe('PROCESSING');
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'payment.delete_awaiting', entityId: old.paymentId } });
    expect(audit).toMatchObject({ actorId: 'system', after: { reason: 'retention' }, before: expect.objectContaining({ paymentRef: old.paymentRef, amount: '150000' }) });
    // a deleted payment's ref no longer resolves
    await http.get(`/v1/dot/payments/status/${old.paymentRef}`).set('x-real-ip', ip()).expect(404);
  });

  it('a completed payment deletes the fee’s other unpaid attempts, but not one Monime is processing', async () => {
    const a = await pay('150000');
    const b = await pay('150000');
    const c = await pay('150000');
    await simulate(c.paymentId, 'processing');
    await simulate(a.paymentId, 'completed');
    expect(await statusOf(a.paymentId)).toBe('COMPLETED');
    expect(await statusOf(b.paymentId)).toBe('DELETED');
    expect(await statusOf(c.paymentId)).toBe('PROCESSING');
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: 'payment.delete_awaiting', entityId: b.paymentId } })).toMatchObject({ after: { reason: expect.stringContaining(a.paymentRef) } });
  });
});

describe('POST /v1/dot/payments/{paymentRef}/resume', () => {
  let ob2: string;
  const resume = (ref: string) => http.post(`/v1/dot/payments/${ref}/resume`).set('x-real-ip', ip());
  const start = async (amount: string) => {
    const r = await http.post('/v1/dot/payments').set('x-real-ip', ip()).set('Idempotency-Key', `resume-${Date.now()}-${++seq}`).send({ obligationId: ob2, amount }).expect(201);
    return r.body;
  };

  // each test gets its own student (UNI-2026-0602, 0603, …), so payments in one can't pay off another's fee
  let n = 1;
  let REF2 = '';
  beforeEach(async () => {
    REF2 = `UNI-2026-06${String(++n).padStart(2, '0')}`;
    await portal(http, 'post', '/v1/portal/events', { events: [{
      id: `evt-resume-${Date.now()}-${n}`, type: 'student.upserted', occurredAt: '2026-11-28T09:00:00Z',
      data: { studentId: REF2, applicationRef: null, fullName: 'Resume Case', phone: `+232766006${String(n).padStart(2, '0')}`, programCode: 'BSC-CS', department: 'COMPUTER-SCI', level: 1, finalYear: false, residency: 'LOCAL', intake: '2026-SEP', enrolmentStatus: 'ACTIVE', updatedAt: '2026-11-28T09:00:00.000Z' },
    }] }).expect(200);
    ob2 = (await prisma.obligation.findFirstOrThrow({ where: { payer: { ref: REF2 }, fee: { feeType: { code: 'TUITION' } } } })).id;
  });

  const completeRef = (paymentId: string, reference: string, monimeId: string, amount: number, metadata: Record<string, string> = {}) =>
    monimeEvent(http, 'payment.processing_completed', { id: monimeId, type: 'payment' }, {
      id: monimeId, status: 'completed', amount: { currency: 'SLE', value: amount }, reference, metadata,
    }).expect(200);

  it('each resume is a new order reference for the same payment; nothing new is created', async () => {
    const p = await start('150000');
    const before = await prisma.payment.count({ where: { obligationId: ob2 } });
    const r1 = (await resume(p.paymentRef).expect(200)).body;
    const r2 = (await resume(p.paymentRef).expect(200)).body;
    expect(r1.order.reference).toBe(`${p.paymentId}.2`);
    expect(r2.order.reference).toBe(`${p.paymentId}.3`);
    for (const [r, n] of [[r1, '2'], [r2, '3']] as const) {
      expect({ ...r, order: { ...r.order, reference: undefined, metadata: { ...r.order.metadata, attempt: undefined } } })
        .toEqual({ ...p, order: { ...p.order, reference: undefined } });
      expect(r.order.metadata).toMatchObject({ paymentId: p.paymentId, paymentRef: p.paymentRef, attempt: n });
      expect(r.order.reference.length).toBeLessThanOrEqual(64);
    }
    expect(await prisma.payment.count({ where: { obligationId: ob2 } })).toBe(before);
    // a webhook for the second attempt, by its reference alone, settles this payment
    const done = await completeRef(p.paymentId, r1.order.reference, 'pay-resume-a2', 150000);
    expect(done.body.result).toBe('PROCESSED');
    expect(await statusOf(p.paymentId)).toBe('COMPLETED');
  });

  it('the first attempt still settles it after a resume', async () => {
    const p = await start('150000');
    await resume(p.paymentRef).expect(200);
    expect((await completeRef(p.paymentId, p.paymentId, 'pay-resume-b1', 150000)).body.result).toBe('PROCESSED');
    expect(await statusOf(p.paymentId)).toBe('COMPLETED');
  });

  it('two attempts both paid: settled once, the second flagged as an overpayment', async () => {
    const p = await start('150000');
    const r = (await resume(p.paymentRef).expect(200)).body;
    const balance = async () => (await prisma.ledgerEntry.aggregate({ where: { obligationId: ob2 }, _sum: { amount: true } }))._sum.amount ?? 0n;
    await completeRef(p.paymentId, r.order.reference, 'pay-resume-c2', 150000);
    const after = await balance();
    const second = await completeRef(p.paymentId, p.paymentId, 'pay-resume-c1', 150000, { paymentId: p.paymentId });
    expect(second.body).toMatchObject({ result: 'UNMATCHED', note: expect.stringContaining(`Paid twice: Monime payment pay-resume-c1`) });
    expect(second.body.note).toContain('overpayment to refund or credit');
    expect(await balance()).toBe(after); // never counted twice on the fee
    expect(await prisma.ledgerEntry.count({ where: { paymentId: p.paymentId } })).toBe(1);
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: p.paymentId } })).toMatchObject({ status: 'COMPLETED', monimePaymentId: 'pay-resume-c2' });
    // shown in the admin reconciliation view
    expect(await prisma.webhookEvent.findFirstOrThrow({ where: { payload: { path: ['data', 'id'], equals: 'pay-resume-c1' } } })).toMatchObject({ status: 'UNMATCHED' });
  });

  it('at most 10 resumes an hour per payment', async () => {
    const p = await start('150000');
    for (let i = 0; i < 10; i++) await resume(p.paymentRef).expect(200);
    const res = await resume(p.paymentRef).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(3000);
    expect(await prisma.paymentAttempt.count({ where: { paymentId: p.paymentId } })).toBe(10);
  });

  it('409 once processing, paid, failed or expired; 404 when gone or unknown', async () => {
    const p = await start('150000');
    await simulate(p.paymentId, 'processing');
    expect((await resume(p.paymentRef).expect(409)).body.error).toMatchObject({ code: 'INVALID_STATE', message: 'This payment is already being processed.' });
    await simulate(p.paymentId, 'completed');
    expect((await resume(p.paymentRef).expect(409)).body.error.message).toBe('This payment is already paid.');
    for (const status of ['FAILED', 'EXPIRED'] as const) {
      const q = await start('150000');
      await prisma.payment.update({ where: { id: q.paymentId }, data: { status } });
      expect((await resume(q.paymentRef).expect(409)).body.error.message).toBe("This payment can't be paid any more. Start a new one.");
    }
    const gone = await start('150000');
    await prisma.payment.delete({ where: { id: gone.paymentId } });
    await resume(gone.paymentRef).expect(404);
    await resume('10000000').expect(404);
    await resume('not-a-ref').expect(404);
  });

  it('422 when another payment has since taken the fee below this amount', async () => {
    const payable = BigInt((await http.get(`/v1/dot/payers/student/${REF2}`).set('x-real-ip', ip()).expect(200)).body.obligations.find((o: { id: string }) => o.id === ob2).payable.value);
    const whole = await start(payable.toString());
    const other = await start('150000');
    await simulate(other.paymentId, 'processing'); // holds 150,000
    expect((await resume(whole.paymentRef).expect(422)).body.error.code).toBe('AMOUNT_EXCEEDS_PAYABLE');
  });

  it('a payment started on USSD is finished there', async () => {
    const p = await start('150000');
    await prisma.payment.update({ where: { id: p.paymentId }, data: { collectionMethod: 'PAYMENT_CODE' } });
    expect((await resume(p.paymentRef).expect(409)).body.error.message).toBe('This payment was started on USSD. Finish it there, or start a new one here.');
  });
});
