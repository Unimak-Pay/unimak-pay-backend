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

/** Students only this file uses; programme BSC-SPC keeps this file's fee to them. */
const ME = 'UNI-2026-0601';
const phoneOf = (ref: string) => `+23276600${ref.slice(-3)}`;
const aliasOf = (ref: string) => `+232 76 600${ref.slice(-3)}`;

let ipSeq = 0;
const ip = () => `10.78.0.${++ipSeq}`;
let seq = 0;
const student = (studentId: string) => ({
  id: `evt-spc-${Date.now()}-${++seq}`, type: 'student.upserted', occurredAt: '2026-11-29T09:00:00Z',
  data: {
    studentId, applicationRef: null, fullName: `Mariama Spc${studentId.slice(-3)} Bangura`, phone: phoneOf(studentId), programCode: 'BSC-SPC',
    department: 'COMPUTER-SCI', level: 2, finalYear: false, residency: 'LOCAL', intake: '2026-SEP', enrolmentStatus: 'ACTIVE',
    updatedAt: '2026-11-29T09:00:00.000Z',
  },
});

let feeId: string;
let obligationId: string;
const key = () => randomUUID().replace(/-/g, '');

/** A pay request from ME, created in the dot; returns its code and webUrl. */
async function newRequest(amount: string | null, idem: string) {
  const res = await http.post('/v1/dot/pay-requests').set('x-real-ip', ip()).set('x-user-alias', aliasOf(ME)).set('Idempotency-Key', idem)
    .send({ kind: 'student', ref: ME, obligationId, amount, message: 'Please help with my fees', recipientName: 'Uncle Sam' }).expect(201);
  return { code: res.body.code as string, webUrl: res.body.webUrl as string };
}

/** The sponsor's browser submitting the form. */
const submit = (code: string, form: Record<string, string>) =>
  http.post(`/p/${code}/checkout`).set('x-real-ip', ip()).type('form').send(form);

beforeAll(async () => {
  app = await createApp();
  http = request(app.getHttpServer());
  await app.get(ProvisionAccountsUseCase).execute();
  const email = `bursar-${randomUUID().slice(0, 8)}@unimak.test`;
  await prisma.adminUser.create({ data: { email, role: 'BURSAR' } });
  const token = adminToken({ sub: randomUUID(), email, aal: 'aal2' });
  const as = (m: 'post' | 'patch', url: string, body: object) => http[m](url).set('authorization', `Bearer ${token}`).send(body);
  const ft = await as('post', '/v1/admin/fee-types', { code: 'SPC', name: 'Sponsor checkout test fee', payerKind: 'STUDENT', recurrence: 'PER_YEAR' }).expect(201);
  feeId = (await as('post', '/v1/admin/fees', { feeTypeId: ft.body.id, name: 'Sponsor test 2026/27', period: '2026/27', allowInstalments: true, defaultMinInstalment: '1000', dueDate: '2027-06-30T00:00:00Z' }).expect(201)).body.id;
  await as('post', `/v1/admin/fees/${feeId}/rate-rules`, { programCode: 'BSC-SPC', amount: '50000' }).expect(201);
  await as('post', `/v1/admin/fees/${feeId}/eligibility-rules`, { programCode: 'BSC-SPC' }).expect(201);
  await as('patch', `/v1/admin/fees/${feeId}`, { status: 'ACTIVE' }).expect(200);
  await portal(http, 'post', '/v1/portal/events', { events: [student(ME)] }).expect(200);
  obligationId = (await prisma.obligation.findFirstOrThrow({ where: { feeId, payer: { ref: ME } } })).id;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('sponsor pays a pay request in a browser', () => {
  it('the request carries a web link that shows first name and programme only', async () => {
    const { code, webUrl } = await newRequest('20000', 'spc-req-0001');
    expect(webUrl).toMatch(new RegExp(`/p/${code}$`));
    const res = await http.get(`/p/${code}`).set('x-real-ip', ip()).expect(200).expect('content-type', /html/);
    expect(res.text).toContain('Pay Sponsor test 2026/27 for Mariama');
    expect(res.text).toContain('BSC-SPC · Level 2');
    expect(res.text).toContain('SLE 200.00');
    expect(res.text).not.toContain('Bangura');
    expect(res.text).not.toContain('600601');
    expect(res.text).toContain('value="momo"');
    expect(res.text).toContain('value="card"');
    await http.get('/p/ZZZZZZZ').set('x-real-ip', ip()).expect(404);
  });

  it('card: a checkout session for card only, then Monime’s payment.completed settles it', async () => {
    const { code } = await newRequest('20000', 'spc-req-0002');
    const k = key();
    const res = await submit(code, { method: 'card', key: k, name: 'Samuel' }).expect(303);
    expect(res.headers.location).toMatch(/^https:\/\/checkout\.mock\.monime\.io\/cos-mock-/);

    const p = await prisma.payment.findFirstOrThrow({ where: { payRequest: { code } } });
    expect(p).toMatchObject({ channel: 'WEB', collectionMethod: 'CHECKOUT_SESSION', status: 'PENDING', amount: 20_000n, paidByName: 'Samuel', payerPhone: null });
    expect(p.checkoutUrl).toBe(res.headers.location);
    const session = await prisma.mockMonimeRecord.findUniqueOrThrow({ where: { id: p.checkoutSessionId! } });
    expect(session.data).toMatchObject({ method: 'card', reference: p.id, successUrl: expect.stringMatching(new RegExp(`/p/${code}/done\\?ref=${p.paymentRef}$`)), metadata: { paymentId: p.id } });

    // a double submit of the same form opens the same page
    const again = await submit(code, { method: 'card', key: k, name: 'Samuel' }).expect(303);
    expect(again.headers.location).toBe(res.headers.location);
    expect(await prisma.payment.count({ where: { payRequest: { code } } })).toBe(1);

    const waiting = await http.get(`/p/${code}/done?ref=${p.paymentRef}`).set('x-real-ip', ip()).expect(200);
    expect(waiting.text).toContain('Waiting for confirmation');

    await http.post('/dev/monime/simulate-webhook').send({ paymentId: p.id, outcome: 'completed', channelType: 'card' }).expect(200);
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect(after).toMatchObject({ status: 'COMPLETED', monimeChannelType: 'card' });

    const done = await http.get(`/p/${code}/done?ref=${p.paymentRef}`).set('x-real-ip', ip()).expect(200);
    expect(done.text).toContain('Payment received');
    expect(done.text).toMatch(/UNIMAK-\d{4}-\d+/);
    const closed = await http.get(`/p/${code}`).set('x-real-ip', ip()).expect(200);
    expect(closed.text).toContain('already been paid');
    await submit(code, { method: 'momo', key: key() }).expect(409);
  });

  it('mobile money: momo only; "whatever you can" takes the typed amount', async () => {
    const { code } = await newRequest(null, 'spc-req-0003');
    const page = await http.get(`/p/${code}`).set('x-real-ip', ip()).expect(200);
    expect(page.text).toContain('name="amount"');
    await submit(code, { method: 'momo', key: key() }).expect(400);
    await submit(code, { method: 'momo', key: key(), amount: 'abc' }).expect(400);
    await submit(code, { method: 'momo', key: key(), amount: '999999' }).expect(400);
    const res = await submit(code, { method: 'momo', key: key(), amount: 'SLE 100.50' }).expect(303);
    const p = await prisma.payment.findFirstOrThrow({ where: { checkoutUrl: res.headers.location } });
    expect(p.amount).toBe(10_050n);
    const session = await prisma.mockMonimeRecord.findUniqueOrThrow({ where: { id: p.checkoutSessionId! } });
    expect(session.data).toMatchObject({ method: 'momo' });
  });

  it('refuses bad input and links that are not requests', async () => {
    const { code } = await newRequest('5000', 'spc-req-0004');
    await submit(code, { method: 'bank', key: key() }).expect(400);
    await submit(code, { method: 'card', key: 'short' }).expect(400);
    await submit('ZZZZZZZ', { method: 'card', key: key() }).expect(404);
    await http.get(`/p/${code}/done?ref=00000000`).set('x-real-ip', ip()).expect(404);
  });

  it('limits checkout pages per link per hour', async () => {
    const { code } = await newRequest('1000', 'spc-req-0005');
    for (let i = 0; i < 10; i++) await submit(code, { method: 'momo', key: key() }).expect(303);
    const res = await submit(code, { method: 'momo', key: key() }).expect(429);
    expect(res.text).toContain('Too many payment attempts');
  });
});
