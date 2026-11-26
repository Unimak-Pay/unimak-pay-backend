import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createApp } from '../../src/bootstrap';
import { PORTAL_CLIENT, type PortalClient } from '../../src/modules/integrations/portal/portal.port';
import { ProvisionAccountsUseCase } from '../../src/modules/treasury/application/provision-accounts.use-case';
import { monimeEvent } from './helpers';

let app: INestApplication;
let http: ReturnType<typeof request>;
const prisma = new PrismaClient();

/** A student only this file uses. */
const REF = 'UNI-2026-0093';
let ipSeq = 0;
/** Each test gets its own client IP, so the per-IP limit doesn't leak between tests. */
const ip = () => `10.9.0.${++ipSeq}`;

beforeAll(async () => {
  app = await createApp();
  http = request(app.getHttpServer());
  await app.get(ProvisionAccountsUseCase).execute();
  const portal = app.get<PortalClient>(PORTAL_CLIENT);
  const real = portal.getStudent.bind(portal);
  jest.spyOn(portal, 'getStudent').mockImplementation(async (ref) =>
    ref === REF
      ? { studentId: ref, fullName: 'Dot Student', phone: '+23276200093', programCode: 'BSC-CS', department: 'COMPUTER-SCI', level: 1, finalYear: false, residency: 'LOCAL', intake: '2026-SEP' }
      : real(ref),
  );
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('public dot API: lookup → payment order → Monime webhook', () => {
  const me = ip();
  const get = (url: string) => http.get(url).set('x-real-ip', me);
  const post = (url: string, body: object, key?: string) => {
    const r = http.post(url).set('x-real-ip', me);
    return (key ? r.set('Idempotency-Key', key) : r).send(body);
  };
  let obligationId: string;
  let paymentId: string;

  it('needs no credentials; full name and academic details, phone masked', async () => {
    const res = await get(`/v1/dot/payers/student/${REF}`).expect(200);
    expect(res.body.payer).toEqual({
      kind: 'student', ref: REF, fullName: 'Dot Student', maskedPhone: '+232*****093', maskedEmail: null,
      programCode: 'BSC-CS', programLine: 'BSC-CS · Level 1',
      department: 'COMPUTER-SCI', departmentName: expect.any(String), facultyCode: expect.any(String), facultyName: expect.any(String),
      level: 1, finalYear: false, residency: 'LOCAL', intake: '2026-SEP', applicantStatus: null, stale: false,
    });
    expect(res.body.payer.phone).toBeUndefined();
    const tuition = res.body.obligations.find((o: { feeTypeCode: string }) => o.feeTypeCode === 'TUITION');
    expect(tuition).toMatchObject({ allowInstalments: true, minInstalment: { value: '150000' }, status: 'OPEN' });
    obligationId = tuition.id;
    const applicant = await get('/v1/dot/payers/applicant/APP-2026-0003').expect(200);
    expect(applicant.body.payer).toMatchObject({ kind: 'applicant', fullName: 'Fatmata Sesay', level: null, finalYear: null, applicantStatus: 'REJECTED', departmentName: expect.any(String) });
    await get('/v1/dot/payers/student/UNI-1999-0000').expect(404);
    await get('/v1/dot/payers/staff/x').expect(400);
  });

  it('quotes with the DOTS channel', async () => {
    const ok = await post('/v1/dot/quotes', { obligationId, amount: '150000' }).expect(200);
    expect(ok.body).toMatchObject({ amount: '150000', minInstalment: '150000', valid: true });
    const low = await post('/v1/dot/quotes', { obligationId, amount: '100' }).expect(422);
    expect(low.body.error.code).toBe('AMOUNT_BELOW_MIN_INSTALMENT');
    await post('/v1/dot/quotes', { obligationId, amount: '150000', channel: 'USSD' }).expect(400); // unknown field
  });

  it('starts a payment: hold, no Monime call, the order for the payment sheet', async () => {
    await post('/v1/dot/payments', { obligationId, amount: '150000' }).expect(400); // no Idempotency-Key
    await post('/v1/dot/payments', { obligationId, amount: '150000' }, 'short').expect(400);

    const key = 'dot-e2e-0093-a';
    const res = await post('/v1/dot/payments', { obligationId, amount: '150000' }, key).expect(201);
    paymentId = res.body.paymentId;
    expect(res.body).toEqual({
      paymentId: expect.any(String),
      paymentRef: expect.stringMatching(/^[1-9]\d{7}$/),
      status: 'PENDING',
      amount: { value: '150000', display: 'SLE 1,500.00' },
      expiresAt: expect.any(String),
      financialAccountId: 'fac-mock-unimak-fee-tuition',
      order: {
        name: 'UNIMAK Tuition 2026/27',
        reference: paymentId,
        lineItems: [{ name: `Tuition 2026/27 · ${REF}`, unitPrice: { currency: 'SLE', value: 150000 }, quantity: 1 }],
        metadata: { paymentId, paymentRef: res.body.paymentRef, obligationId, payerRef: REF, feeTypeCode: 'TUITION', channel: 'DOTS' },
      },
    });
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(p).toMatchObject({ channel: 'DOTS', collectionMethod: 'DASH_SHEET', clientId: 'dash-dot', monimeRef: null, ussdCode: null, payerPhone: null });

    // a retry gets the same payment and order; the key can't be reused for another amount
    const again = await post('/v1/dot/payments', { obligationId, amount: '150000' }, key).expect(201);
    expect(again.body).toEqual(res.body);
    const conflict = await post('/v1/dot/payments', { obligationId, amount: '160000' }, key).expect(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    // awaiting payment holds nothing; once Monime is processing it, it holds the amount
    const t = async () => (await get(`/v1/dot/payers/student/${REF}`).expect(200)).body.obligations.find((o: { id: string }) => o.id === obligationId);
    expect((await t()).holds).toEqual({ value: '0', display: 'SLE 0.00' });
    await http.post('/dev/monime/simulate-webhook').send({ paymentId, outcome: 'processing' }).expect(200);
    expect((await t()).holds).toEqual({ value: '150000', display: 'SLE 1,500.00' });
  });

  it('is settled by payment.processing_completed matched on reference', async () => {
    const ack = await monimeEvent(http, 'payment.processing_completed', { id: 'pay-dot-0093', type: 'payment' }, {
      id: 'pay-dot-0093', status: 'completed', amount: { currency: 'SLE', value: 150000 },
      reference: paymentId, financialAccountId: 'fac-mock-unimak-fee-tuition', orderNumber: 'DOT0093XYZ',
      metadata: { paymentId, channel: 'DOTS' }, channel: { phoneNumber: '+23276****93' },
    }).expect(200);
    expect(ack.body.result).toBe('PROCESSED');

    const p = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(p).toMatchObject({ status: 'COMPLETED', monimePaymentId: 'pay-dot-0093', monimeOrderNumber: 'DOT0093XYZ' });
    const status = await get(`/v1/dot/payments/status/${p.paymentRef}`).expect(200);
    expect(status.body).toMatchObject({ status: 'COMPLETED', payer: { ref: REF, maskedName: 'D*** S***' }, receiptNumber: expect.stringMatching(/^UNIMAK-/) });
    expect((await get('/v1/dot/payments/status/dot0093xyz').expect(200)).body.paymentRef).toBe(p.paymentRef);
    await get('/v1/dot/payments/status/12345678').expect(404);
  });
});

describe('public dot API limits', () => {
  it('limits each IP per minute (429 with Retry-After) without affecting other IPs', async () => {
    const flood = ip();
    let last: request.Response | undefined;
    for (let i = 0; i <= 60; i++) last = await http.get('/v1/dot/payments/status/12345678').set('x-real-ip', flood);
    expect(last!.status).toBe(429);
    expect(last!.body.error.code).toBe('RATE_LIMITED');
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
    await http.get('/v1/dot/payments/status/12345678').set('x-real-ip', ip()).expect(404);
  });

  it('is not the HMAC channel API', async () => {
    await http.get(`/v1/channel/payers/student/${REF}`).expect(401);
  });
});
