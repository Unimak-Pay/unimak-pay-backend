import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createApp } from '../../src/bootstrap';
import { ProvisionAccountsUseCase } from '../../src/modules/treasury/application/provision-accounts.use-case';
import { adminToken, portal } from './helpers';

let app: INestApplication;
let http: ReturnType<typeof request>;
const prisma = new PrismaClient();

/** Students only this file uses, sent as portal events; programme BSC-DXT keeps this file's fee to them. */
const ME = 'UNI-2026-0501';
const OTHER = 'UNI-2026-0502';
const phoneOf = (ref: string) => `+23276500${ref.slice(-3)}`;
/** How the dot sends it: Dash's own formatting, not ours. */
const aliasOf = (ref: string) => `+232 76 500${ref.slice(-3)}`;

let ipSeq = 0;
/** Each test gets its own client IP, so the per-IP limits don't leak between tests. */
const ip = () => `10.77.0.${++ipSeq}`;
const dot = (who: string, alias?: string) => ({
  get: (url: string) => { const r = http.get(url).set('x-real-ip', who); return alias ? r.set('x-user-alias', alias) : r; },
  post: (url: string, body: object, key?: string) => {
    let r = http.post(url).set('x-real-ip', who);
    if (alias) r = r.set('x-user-alias', alias);
    if (key) r = r.set('Idempotency-Key', key);
    return r.send(body);
  },
});

let seq = 0;
const student = (studentId: string) => ({
  id: `evt-dxt-${Date.now()}-${++seq}`, type: 'student.upserted', occurredAt: '2026-11-26T09:00:00Z',
  data: {
    studentId, applicationRef: null, fullName: `Abdul Dxt${studentId.slice(-3)} Koroma`, phone: phoneOf(studentId), programCode: 'BSC-DXT',
    department: 'COMPUTER-SCI', level: 1, finalYear: false, residency: 'LOCAL', intake: '2026-SEP', enrolmentStatus: 'ACTIVE',
    updatedAt: '2026-11-26T09:00:00.000Z',
  },
});

let feeId: string;
const obligationOf = async (ref: string) => (await prisma.obligation.findFirstOrThrow({ where: { feeId, payer: { ref } } })).id;
const complete = (paymentId: string) => http.post('/dev/monime/simulate-webhook').send({ paymentId, outcome: 'completed' }).expect(200);

beforeAll(async () => {
  app = await createApp();
  http = request(app.getHttpServer());
  await app.get(ProvisionAccountsUseCase).execute();
  const email = `bursar-${randomUUID().slice(0, 8)}@unimak.test`;
  await prisma.adminUser.create({ data: { email, role: 'BURSAR' } });
  const token = adminToken({ sub: randomUUID(), email, aal: 'aal2' });
  const as = (m: 'post' | 'patch', url: string, body: object) => http[m](url).set('authorization', `Bearer ${token}`).send(body);

  const ft = await as('post', '/v1/admin/fee-types', { code: 'DXT', name: 'Dot extras test fee', payerKind: 'STUDENT', recurrence: 'PER_YEAR' }).expect(201);
  feeId = (await as('post', '/v1/admin/fees', { feeTypeId: ft.body.id, name: 'Dot extras 2026/27', period: '2026/27', allowInstalments: true, defaultMinInstalment: '1000', dueDate: '2027-06-30T00:00:00Z' }).expect(201)).body.id;
  await as('post', `/v1/admin/fees/${feeId}/rate-rules`, { programCode: 'BSC-DXT', amount: '30000' }).expect(201);
  await as('post', `/v1/admin/fees/${feeId}/eligibility-rules`, { programCode: 'BSC-DXT' }).expect(201);
  await as('patch', `/v1/admin/fees/${feeId}`, { status: 'ACTIVE' }).expect(200);
  await portal(http, 'post', '/v1/portal/events', { events: [student(ME), student(OTHER)] }).expect(200);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('X-User-Alias on the payer lookup', () => {
  it('without the header (dots before 0.2.3): the full record, as today', async () => {
    const res = await dot(ip()).get(`/v1/dot/payers/student/${ME}`).expect(200);
    expect(res.body.payer).toMatchObject({ fullName: 'Abdul Dxt501 Koroma', maskedPhone: '+232*****501', programLine: 'BSC-DXT · Level 1' });
  });

  it('matches the number however Dash writes it', async () => {
    for (const alias of [aliasOf(ME), '076500501', '23276500501']) {
      const res = await dot(ip(), alias).get(`/v1/dot/payers/student/${ME}`).expect(200);
      expect(res.body.payer.fullName).toBe('Abdul Dxt501 Koroma');
    }
  });

  it('another number (a sponsor) gets only what is needed to pay', async () => {
    const res = await dot(ip(), '+232 77 999999').get(`/v1/dot/payers/student/${ME}`).expect(200);
    expect(res.body.payer).toEqual({ kind: 'student', ref: ME, shortName: 'Abdul K.', limited: true, stale: false });
    expect(res.body.obligations.find((o: { id: string }) => o.id)).toBeDefined();
    expect(JSON.stringify(res.body)).not.toMatch(/Koroma|76500501|\+232/);
  });

  it('after too many wrong numbers it stops checking and answers short, even for the right one', async () => {
    const who = ip();
    for (let i = 0; i < 10; i++) await dot(who, `+232 77 1000${String(i).padStart(2, '0')}`).get(`/v1/dot/payers/student/${OTHER}`).expect(200);
    const res = await dot(who, aliasOf(OTHER)).get(`/v1/dot/payers/student/${OTHER}`).expect(200);
    expect(res.body.payer.limited).toBe(true);
    // a private route answers 429 with Retry-After
    const limited = await dot(who, aliasOf(OTHER)).get(`/v1/dot/payers/student/${OTHER}/pay-requests`).expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('pay requests', () => {
  const mine = () => dot(ip(), aliasOf(ME));
  let obligationId: string;
  let code: string;

  beforeAll(async () => {
    obligationId = await obligationOf(ME);
  });

  const body = (over: object = {}) => ({ kind: 'student', ref: ME, obligationId, amount: '20000', message: 'Hi, can you help me pay towards my UNIMAK fee?', recipientName: 'Fatmata', ...over });

  it('needs the student’s own number', async () => {
    const missing = await dot(ip()).post('/v1/dot/pay-requests', body(), 'req-key-0001').expect(403);
    expect(missing.body.error.code).toBe('ALIAS_REQUIRED');
    const wrong = await dot(ip(), '+232 77 999999').post('/v1/dot/pay-requests', body(), 'req-key-0001').expect(403);
    expect(wrong.body.error).toEqual({
      code: 'ALIAS_MISMATCH',
      message: "This ID isn't linked to the Dash number you're using. Use the number the university has for you, or contact the finance office.",
      details: null,
    });
  });

  it('creates one, idempotently', async () => {
    const res = await mine().post('/v1/dot/pay-requests', body(), 'req-key-0001').expect(201);
    code = res.body.code;
    expect(res.body).toMatchObject({
      code: expect.stringMatching(/^[2-9A-HJKMNP-Z]{7}$/),
      obligationId, feeName: 'Dot extras 2026/27',
      amount: { value: '20000', display: 'SLE 200.00' }, paid: { value: '0', display: 'SLE 0.00' }, status: 'OPEN',
      requester: { kind: 'student', ref: ME, firstName: 'Abdul', programLine: 'BSC-DXT · Level 1' },
      recipientName: 'Fatmata', contributions: [], openedAt: null,
    });
    const url = new URL(res.body.shareUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://dashit.to/d/k6X5mJ6TFSnLUm8KwUjqWu4Mcf5/sponsor');
    expect(Object.fromEntries(url.searchParams)).toEqual({ request: code, kind: 'student', ref: ME, fee: obligationId, amount: '20000' });
    expect(new Date(res.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);

    const again = await mine().post('/v1/dot/pay-requests', body(), 'req-key-0001').expect(201);
    expect(again.body.code).toBe(code);
    const conflict = await mine().post('/v1/dot/pay-requests', body({ amount: '1000' }), 'req-key-0001').expect(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('refuses more than the fee’s payable, and bad input', async () => {
    const res = await mine().post('/v1/dot/pay-requests', body({ amount: '30001' }), 'req-key-0002').expect(422);
    expect(res.body.error.code).toBe('AMOUNT_EXCEEDS_PAYABLE');
    await mine().post('/v1/dot/pay-requests', body({ message: '   ' }), 'req-key-0003').expect(400);
    await mine().post('/v1/dot/pay-requests', body({ message: 'x'.repeat(281) }), 'req-key-0004').expect(400);
    await mine().post('/v1/dot/pay-requests', body(), undefined).expect(400);
    await mine().post('/v1/dot/pay-requests', body({ obligationId: randomUUID() }), 'req-key-0005').expect(404);
  });

  it('"whatever you can" has no amount and an empty amount in the link', async () => {
    const res = await mine().post('/v1/dot/pay-requests', body({ amount: null, recipientName: null }), 'req-key-0006').expect(201);
    expect(res.body.amount).toBeNull();
    expect(new URL(res.body.shareUrl).searchParams.get('amount')).toBe('');
  });

  it('a sponsor opens it without a match; the first open is recorded once', async () => {
    const sponsor = dot(ip(), '+232 77 999999');
    const first = await sponsor.get(`/v1/dot/pay-requests/${code}`).expect(200);
    expect(first.body.openedAt).toEqual(expect.any(String));
    const second = await sponsor.get(`/v1/dot/pay-requests/${code.toLowerCase()}`).expect(200);
    expect(second.body.openedAt).toBe(first.body.openedAt);
    expect(JSON.stringify(first.body)).not.toMatch(/Koroma|76500501|\+232/);
    await sponsor.get('/v1/dot/pay-requests/ZZZZZZZ').expect(404);
    await sponsor.get('/v1/dot/pay-requests/not-a-code').expect(404);
  });

  it('a payment counts towards it only once Monime completes it', async () => {
    const sponsor = dot(ip(), '+232 77 999999');
    const pay = await sponsor.post('/v1/dot/payments', { obligationId, amount: '12000', payRequestCode: code, paidByName: '  Fatmata Sesay ' }, 'pay-dxt-0001').expect(201);
    expect(pay.body.order.metadata.payRequestCode).toBe(code);
    expect((await sponsor.get(`/v1/dot/pay-requests/${code}`)).body).toMatchObject({ status: 'OPEN', paid: { value: '0' }, contributions: [] });

    await complete(pay.body.paymentId);
    const after = (await sponsor.get(`/v1/dot/pay-requests/${code}`)).body;
    expect(after).toMatchObject({ status: 'PARTLY_PAID', paid: { value: '12000' } });
    expect(after.contributions).toEqual([{ paymentRef: pay.body.paymentRef, name: 'Fatmata', amount: { value: '12000', display: 'SLE 120.00' }, paidAt: expect.any(String) }]);
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: pay.body.paymentId } })).toMatchObject({ paidByName: 'Fatmata', payingForSelf: false, monimeChannelType: 'momo' });

    const rest = await sponsor.post('/v1/dot/payments', { obligationId, amount: '8000', payRequestCode: code }, 'pay-dxt-0002').expect(201);
    await complete(rest.body.paymentId);
    expect((await sponsor.get(`/v1/dot/pay-requests/${code}`)).body).toMatchObject({ status: 'PAID', paid: { value: '20000' } });

    // closed now; a retry of a payment already started through it still replays
    const closed = await sponsor.post('/v1/dot/payments', { obligationId, amount: '1000', payRequestCode: code }, 'pay-dxt-0003').expect(409);
    expect(closed.body.error.code).toBe('INVALID_STATE');
    const replay = await sponsor.post('/v1/dot/payments', { obligationId, amount: '8000', payRequestCode: code }, 'pay-dxt-0002').expect(201);
    expect(replay.body.paymentId).toBe(rest.body.paymentId);
  });

  it('checks the request against the fee and the key against the request', async () => {
    const sponsor = dot(ip());
    const fresh = await mine().post('/v1/dot/pay-requests', body({ amount: '1000' }), 'req-key-0007').expect(201);
    await sponsor.post('/v1/dot/payments', { obligationId: await obligationOf(OTHER), amount: '1000', payRequestCode: fresh.body.code }, 'pay-dxt-0004').expect(400);
    await sponsor.post('/v1/dot/payments', { obligationId, amount: '1000', payRequestCode: 'ZZZZZZZ' }, 'pay-dxt-0005').expect(404);
    await sponsor.post('/v1/dot/payments', { obligationId, amount: '1000' }, 'pay-dxt-0006').expect(201);
    const conflict = await sponsor.post('/v1/dot/payments', { obligationId, amount: '1000', payRequestCode: fresh.body.code }, 'pay-dxt-0006').expect(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('still rejects fields it does not know', async () => {
    await dot(ip()).post('/v1/dot/payments', { obligationId, amount: '1000', tip: '5' }, 'pay-dxt-0007').expect(400);
  });

  it('lists the student’s requests, newest first, with a match', async () => {
    const res = await mine().get(`/v1/dot/payers/student/${ME}/pay-requests`).expect(200);
    expect(res.body.requests.length).toBe(3);
    expect(res.body.requests.at(-1).code).toBe(code);
    await dot(ip(), '+232 77 999999').get(`/v1/dot/payers/student/${ME}/pay-requests`).expect(403);
    await dot(ip()).get(`/v1/dot/payers/student/${ME}/pay-requests`).expect(403);
  });
});
