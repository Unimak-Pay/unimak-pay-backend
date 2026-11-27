import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { type Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createApp } from '../../src/bootstrap';
import { ProvisionAccountsUseCase } from '../../src/modules/treasury/application/provision-accounts.use-case';
import { adminToken, channel } from './helpers';

let app: INestApplication;
let http: ReturnType<typeof request>;
const prisma = new PrismaClient();
const today = new Date().toISOString().slice(0, 10);
const startOfToday = new Date(`${today}T00:00:00Z`);

async function admin(role: 'SUPER_ADMIN' | 'FINANCE_OFFICER' | 'HEAD_OF_DEPARTMENT', departments: string[] = [], extraPermissions: string[] = []) {
  const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@unimak.test`;
  await prisma.adminUser.create({ data: { email, role, departments, extraPermissions } });
  const token = adminToken({ sub: randomUUID(), email, aal: 'aal2' });
  return (query = '') => http.get(`/v1/admin/reports/summary${query}`).set('authorization', `Bearer ${token}`);
}

/** Independent oracle: completed today, straight from Prisma. */
async function collectedToday(where: Prisma.PaymentWhereInput = {}) {
  const r = await prisma.payment.aggregate({ where: { status: 'COMPLETED', completedAt: { gte: startOfToday }, ...where }, _sum: { amount: true }, _count: { _all: true } });
  return { amount: (r._sum.amount ?? 0n).toString(), count: r._count._all };
}

async function start(feeType: string, ch: 'USSD' | 'DOTS', amount: string) {
  const ob = await channel(http, 'get', '/v1/channel/payers/student/UNI-2023-0010/obligations').expect(200);
  const o = ob.body.obligations.find((x: { feeTypeCode: string }) => x.feeTypeCode === feeType);
  const res = await channel(http, 'post', '/v1/channel/payments', { obligationId: o.id, amount, payerPhone: '+23272200010', channel: ch, idempotencyKey: `rep-${feeType}-${ch}` }).expect(201);
  return res.body.paymentId as string;
}
const complete = (paymentId: string) => http.post('/dev/monime/simulate-webhook').send({ paymentId, outcome: 'completed' }).expect(200);

beforeAll(async () => {
  app = await createApp();
  http = request(app.getHttpServer());
  await app.get(ProvisionAccountsUseCase).execute();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('GET /v1/admin/reports/summary', () => {
  it('counts completed payments by day, fee type and channel, and the payment funnel', async () => {
    const report = await admin('SUPER_ADMIN');
    const before = (await report(`?from=${today}&to=${today}`).expect(200)).body;

    await complete(await start('DEPT', 'USSD', '30000')); // SLE 300
    await complete(await start('GRAD', 'DOTS', '75000')); // SLE 750
    const pending = await start('TUITION', 'USSD', '200000'); // started, not completed

    const after = (await report(`?from=${today}&to=${today}`).expect(200)).body;
    expect(after.range).toEqual({ from: today, to: today, days: 1, timezone: 'Africa/Freetown (UTC)' });
    expect(BigInt(after.collected.amount) - BigInt(before.collected.amount)).toBe(105_000n);
    expect(after.collected.count - before.collected.count).toBe(2);
    expect(after.collected).toMatchObject(await collectedToday());
    expect(after.byDay).toEqual([{ date: today, amount: after.collected.amount, count: after.collected.count }]);

    const fee = (body: { byFeeType: { feeTypeCode: string; amount: string }[] }, code: string) => BigInt(body.byFeeType.find((r) => r.feeTypeCode === code)?.amount ?? '0');
    expect(fee(after, 'DEPT') - fee(before, 'DEPT')).toBe(30_000n);
    expect(fee(after, 'GRAD') - fee(before, 'GRAD')).toBe(75_000n);
    const ch = (body: { byChannel: { channel: string; amount: string }[] }, c: string) => BigInt(body.byChannel.find((r) => r.channel === c)!.amount);
    expect(ch(after, 'DOTS') - ch(before, 'DOTS')).toBe(75_000n);
    expect(after.byChannel.map((r: { channel: string }) => r.channel)).toEqual(['USSD', 'DOTS', 'WEB']);

    expect(after.payments.started - before.payments.started).toBe(3);
    expect(after.payments.pending.count - before.payments.pending.count).toBe(1);
    expect(after.payments.completionRate).toBeGreaterThan(0);
    // split adds up
    const c = after.collected;
    expect(BigInt(c.monimeFees) + BigInt(c.platformFees) + BigInt(c.net)).toBe(BigInt(c.amount));
    // commission transfers and payouts are reported for roles that can read them
    expect(after.commission).toMatchObject({ transferred: expect.any(Object), inFlight: expect.any(Object), failed: expect.any(Object) });
    expect(after.payouts).toMatchObject({ paidOut: expect.any(Object) });

    // payments don't expire: past its old expiry time it is still pending; once Monime
    // starts processing it, it moves to "processing"
    await prisma.payment.update({ where: { id: pending }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const later = (await report(`?from=${today}&to=${today}`).expect(200)).body;
    expect(later.payments.pending.count).toBe(after.payments.pending.count);
    expect(later.payments.expired.count).toBe(after.payments.expired.count);
    await http.post('/dev/monime/simulate-webhook').send({ paymentId: pending, outcome: 'processing' }).expect(200);
    const processing = (await report(`?from=${today}&to=${today}`).expect(200)).body;
    expect(processing.payments.pending.count).toBe(after.payments.pending.count - 1);
    expect(processing.payments.processing.count).toBe(after.payments.processing.count + 1);
  });

  it('filters by fee type and channel; defaults to the last 30 days', async () => {
    const report = await admin('SUPER_ADMIN');
    const grad = (await report(`?from=${today}&to=${today}&feeType=GRAD`).expect(200)).body;
    expect(grad.collected).toMatchObject(await collectedToday({ obligation: { fee: { feeType: { code: 'GRAD' } } } }));
    expect(grad.byFeeType.map((r: { feeTypeCode: string }) => r.feeTypeCode)).toEqual(['GRAD']);
    const dots = (await report(`?from=${today}&to=${today}&channel=DOTS`).expect(200)).body;
    expect(dots.collected).toMatchObject(await collectedToday({ channel: 'DOTS' }));
    expect(dots.byChannel).toHaveLength(1);

    const def = (await report().expect(200)).body;
    expect(def.range).toMatchObject({ to: today, days: 30 });
    expect(def.byDay).toHaveLength(30);
    expect(def.byDay.at(-1).date).toBe(today);
  });

  it('heads of department only see their departments, without commission or payouts', async () => {
    const health = await admin('HEAD_OF_DEPARTMENT', ['NURSING']);
    const body = (await health(`?from=${today}&to=${today}`).expect(200)).body;
    expect(body.filters.departments).toEqual(['NURSING']);
    expect(body.collected).toMatchObject(await collectedToday({ obligation: { payer: { department: 'NURSING' } } }));
    expect(body.byFeeType.find((r: { feeTypeCode: string }) => r.feeTypeCode === 'GRAD')).toBeUndefined(); // UNI-2023-0010 is COMPUTER-SCI
    expect(body).toMatchObject({ commission: null, payouts: null });

    // commission is super-admin only unless transfers.read is granted
    const fo = await admin('FINANCE_OFFICER');
    expect((await fo(`?from=${today}&to=${today}`).expect(200)).body.commission).toBeNull();
    const granted = await admin('FINANCE_OFFICER', [], ['transfers.read']);
    expect((await granted(`?from=${today}&to=${today}`).expect(200)).body.commission).not.toBeNull();
  });

  it('validates the range', async () => {
    const report = await admin('SUPER_ADMIN');
    expect((await report('?from=2026-11-10&to=2026-11-01').expect(400)).body.error.code).toBe('VALIDATION');
    expect((await report('?from=2024-01-01&to=2026-01-01').expect(400)).body.error.message).toMatch(/at most 366 days/);
    await report('?from=2026-13-45').expect(400);
    await report('?channel=SMS').expect(400);
    await http.get('/v1/admin/reports/summary').expect(401);
  });
});
