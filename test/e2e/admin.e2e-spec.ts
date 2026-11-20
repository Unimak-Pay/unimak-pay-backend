import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createApp } from '../../src/bootstrap';
import { AUTH_INVITER, type AuthInviter } from '../../src/modules/auth/application/auth-inviter.port';
import { ProvisionAccountsUseCase } from '../../src/modules/treasury/application/provision-accounts.use-case';
import { adminToken, channel, monimeEvent } from './helpers';

let app: INestApplication;
let http: ReturnType<typeof request>;
const prisma = new PrismaClient();

/** Creates an AdminUser invitation and returns a token for it. */
async function admin(role: 'SUPER_ADMIN' | 'BURSAR' | 'FINANCE_OFFICER' | 'HEAD_OF_DEPARTMENT' | 'AUDITOR', opts: { departments?: string[]; extra?: string[]; aal?: 'aal1' | 'aal2' } = {}) {
  const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@unimak.test`;
  await prisma.adminUser.create({ data: { email, role, departments: opts.departments ?? [], extraPermissions: opts.extra ?? [] } });
  const sub = randomUUID();
  return { email, sub, token: adminToken({ sub, email, aal: opts.aal ?? 'aal2' }) };
}
const get = (url: string, token: string) => http.get(url).set('authorization', `Bearer ${token}`);
const post = (url: string, token: string, body?: object) => http.post(url).set('authorization', `Bearer ${token}`).send(body ?? {});

async function pay(kind: 'student' | 'applicant', ref: string, phone: string, feeType: string, amount: string): Promise<string> {
  const ob = await channel(http, 'get', `/v1/channel/payers/${kind}/${ref}/obligations`).expect(200);
  const o = ob.body.obligations.find((x: { feeTypeCode: string }) => x.feeTypeCode === feeType);
  const res = await channel(http, 'post', '/v1/channel/payments', { obligationId: o.id, amount, payerPhone: phone, channel: 'USSD', idempotencyKey: `adm-${ref}-${feeType}-${amount}` }).expect(201);
  await http.post('/dev/monime/simulate-webhook').send({ paymentId: res.body.paymentId, outcome: 'completed' }).expect(200);
  return res.body.paymentId;
}

beforeAll(async () => {
  app = await createApp();
  http = request(app.getHttpServer());
  await app.get(ProvisionAccountsUseCase).execute();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('admin authentication (Supabase Auth JWT)', () => {
  it('rejects missing, malformed, expired and wrongly signed tokens', async () => {
    await http.get('/v1/admin/me').expect(401);
    await get('/v1/admin/me', 'not-a-jwt').expect(401);
    const { sub, email } = await admin('AUDITOR');
    await get('/v1/admin/me', adminToken({ sub, email, exp: Math.floor(Date.now() / 1000) - 120 })).expect(401);
    const t = adminToken({ sub, email });
    const [h, b] = t.split('.');
    const forged = `${h}.${b}.${Buffer.alloc(64).toString('base64url')}`;
    const res = await get('/v1/admin/me', forged).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('is invite-only: a valid Supabase user who is not an admin gets 403', async () => {
    const res = await get('/v1/admin/me', adminToken({ sub: randomUUID(), email: 'stranger@example.com', aal: 'aal2' })).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('binds the invitation to the Supabase user on first login; email alone no longer works after', async () => {
    const a = await admin('FINANCE_OFFICER');
    const me = await get('/v1/admin/me', a.token).expect(200);
    expect(me.body).toMatchObject({ email: a.email, role: 'FINANCE_OFFICER', departmentScoped: false });
    expect(me.body.permissions).toContain('payments.read');
    expect((await prisma.adminUser.findUnique({ where: { email: a.email } }))?.authUserId).toBe(a.sub);
    // a different Supabase account claiming the same email can't take it over
    await get('/v1/admin/me', adminToken({ sub: randomUUID(), email: a.email, aal: 'aal2' })).expect(403);
  });

  it('requires 2FA (aal2) for super admin and bursar', async () => {
    const b = await admin('BURSAR', { aal: 'aal1' });
    const res = await get('/v1/admin/me', b.token).expect(403);
    expect(res.body.error.code).toBe('MFA_REQUIRED');
    await get('/v1/admin/me', adminToken({ sub: b.sub, email: b.email, aal: 'aal2' })).expect(200);
    // finance officers may sign in without 2FA
    const f = await admin('FINANCE_OFFICER', { aal: 'aal1' });
    await get('/v1/admin/me', f.token).expect(200);
  });

  it('rejects deactivated admins and anonymous / non-user tokens', async () => {
    const a = await admin('AUDITOR');
    await prisma.adminUser.update({ where: { email: a.email }, data: { active: false } });
    await get('/v1/admin/me', a.token).expect(403);
    const b = await admin('AUDITOR');
    await get('/v1/admin/me', adminToken({ sub: b.sub, email: b.email, role: 'anon' })).expect(401);
  });
});

describe('permissions and department scope', () => {
  let csPayment: string;
  let nurPayment: string;

  beforeAll(async () => {
    csPayment = await pay('student', 'UNI-2023-0004', '+23279200004', 'TUITION', '150000'); // COMPUTER-SCI
    nurPayment = await pay('student', 'UNI-2024-0007', '+23234200007', 'TUITION', '200000'); // NURSING
  });

  it('finance officer can read payments but not move money or provision accounts', async () => {
    const f = await admin('FINANCE_OFFICER');
    const list = await get('/v1/admin/payments?status=COMPLETED', f.token).expect(200);
    expect(list.body.items.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining([csPayment, nurPayment]));
    expect(typeof list.body.items[0].amount).toBe('string'); // bigint → string
    const res = await post('/v1/admin/payouts', f.token, { account: 'unimak-fee-tuition', amount: '1000', bankProviderId: 'slb001', accountNumber: '0011223344', idempotencyKey: 'fo-payout-1' }).expect(403);
    expect(res.body.error.message).toBe('Missing permission payouts.manage');
    await post('/v1/admin/financial-accounts/provision', f.token).expect(403);
  });

  it('heads of department only see their department', async () => {
    const h = await admin('HEAD_OF_DEPARTMENT', { departments: ['NURSING'] });
    const list = await get('/v1/admin/payments', h.token).expect(200);
    const ids = list.body.items.map((p: { id: string }) => p.id);
    expect(ids).toContain(nurPayment);
    expect(ids).not.toContain(csPayment);
    expect(list.body.items.every((p: { payer: { department: string } }) => p.payer.department === 'NURSING')).toBe(true);
    await get(`/v1/admin/payments/${csPayment}`, h.token).expect(404);
    await get(`/v1/admin/payments/${nurPayment}`, h.token).expect(200);
  });

  it('a single permission can be granted on its own', async () => {
    const f = await admin('FINANCE_OFFICER', { extra: ['outbox.read'] });
    await get('/v1/admin/outbox', f.token).expect(200);
    const g = await admin('FINANCE_OFFICER');
    await get('/v1/admin/outbox', g.token).expect(403);
  });
});

describe('admin users', () => {
  it('super admin invites users (audited); cannot deactivate self; keeps one super admin', async () => {
    const s = await admin('SUPER_ADMIN');
    const me = await get('/v1/admin/me', s.token).expect(200);
    const created = await post('/v1/admin/users', s.token, { email: 'New.Officer@UNIMAK.test', role: 'FINANCE_OFFICER' }).expect(201);
    expect(created.body).toMatchObject({ email: 'new.officer@unimak.test', role: 'FINANCE_OFFICER', active: true });
    expect(await prisma.auditLog.count({ where: { action: 'admin_user.create', entityId: created.body.id, actorId: me.body.id } })).toBe(1);

    await post('/v1/admin/users', s.token, { email: 'hod@unimak.test', role: 'HEAD_OF_DEPARTMENT' }).expect(400);
    const self = await http.patch(`/v1/admin/users/${me.body.id}`).set('authorization', `Bearer ${s.token}`).send({ active: false }).expect(403);
    expect(self.body.error.message).toMatch(/cannot deactivate yourself/);

    // make `s` the only active super admin, then let a users.manage holder try to remove it
    await prisma.adminUser.updateMany({ where: { role: 'SUPER_ADMIN', id: { not: me.body.id } }, data: { active: false } });
    const manager = await admin('FINANCE_OFFICER', { extra: ['users.manage'] });
    const last = await http.patch(`/v1/admin/users/${me.body.id}`).set('authorization', `Bearer ${manager.token}`).send({ active: false }).expect(409);
    expect(last.body.error.message).toBe('At least one active super admin must remain');
  });

  it('asks Supabase to email the invite; the admin exists even if that fails; re-send until first sign-in', async () => {
    const s = await admin('SUPER_ADMIN');
    // test env has no service role key
    const plain = await post('/v1/admin/users', s.token, { email: `nokey-${randomUUID().slice(0, 6)}@unimak.test`, role: 'AUDITOR' }).expect(201);
    expect(plain.body.invitation).toEqual({ status: 'NOT_CONFIGURED', message: expect.stringMatching(/SUPABASE_SERVICE_ROLE_KEY/) });

    const inviter = app.get<AuthInviter>(AUTH_INVITER);
    const spy = jest.spyOn(inviter, 'invite').mockResolvedValueOnce({ status: 'FAILED', message: 'Supabase email rate limit reached' });
    try {
      const email = `invitee-${randomUUID().slice(0, 6)}@unimak.test`;
      const created = await post('/v1/admin/users', s.token, { email: email.toUpperCase(), role: 'FINANCE_OFFICER' }).expect(201);
      expect(spy).toHaveBeenLastCalledWith(email);
      expect(created.body).toMatchObject({ email, authUserId: null, invitation: { status: 'FAILED' } });
      expect(await prisma.adminUser.count({ where: { email } })).toBe(1);

      spy.mockResolvedValueOnce({ status: 'SENT' });
      const resent = await post(`/v1/admin/users/${created.body.id}/invite`, s.token, {}).expect(200);
      expect(resent.body.invitation).toEqual({ status: 'SENT' });
      const audits = await prisma.auditLog.findMany({ where: { action: 'admin_user.invite', entityId: created.body.id }, orderBy: { at: 'asc' } });
      expect(audits.map((a) => (a.after as { status: string }).status)).toEqual(['FAILED', 'SENT']);

      // once they've signed in, there is nothing to re-send
      const token = adminToken({ sub: randomUUID(), email, aal: 'aal2' });
      await get('/v1/admin/me', token).expect(200);
      const bound = await post(`/v1/admin/users/${created.body.id}/invite`, s.token, {}).expect(409);
      expect(bound.body.error.message).toMatch(/already signed in/);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('users.manage holders cannot escalate privileges', async () => {
    const manager = await admin('FINANCE_OFFICER', { extra: ['users.manage'] });
    const su = await post('/v1/admin/users', manager.token, { email: 'sneaky@unimak.test', role: 'SUPER_ADMIN' }).expect(403);
    expect(su.body.error.message).toBe('Only a super admin can create or change super admins');
    const bursar = await post('/v1/admin/users', manager.token, { email: 'sneaky2@unimak.test', role: 'BURSAR' }).expect(403);
    expect(bursar.body.error.message).toMatch(/cannot grant permissions you don't have: .*fees.manage/);
    const extra = await post('/v1/admin/users', manager.token, { email: 'sneaky3@unimak.test', role: 'AUDITOR', extraPermissions: ['payouts.manage'] }).expect(403);
    expect(extra.body.error.message).toMatch(/payouts.manage/);
    // within their own permissions is fine
    await post('/v1/admin/users', manager.token, { email: 'peer@unimak.test', role: 'FINANCE_OFFICER' }).expect(201);
  });
});

describe('money operations behind admin auth', () => {
  it('super admin requests a payout (audited); balances and banks are visible', async () => {
    await pay('student', 'UNI-2025-0009', '+23299200009', 'TUITION', '300000');
    const s = await admin('SUPER_ADMIN');
    const accounts = await get('/v1/admin/financial-accounts', s.token).expect(200);
    const tuition = accounts.body.find((a: { reference: string }) => a.reference === 'unimak-fee-tuition');
    const refreshed = await post(`/v1/admin/financial-accounts/${tuition.id}/refresh-balance`, s.token).expect(200);
    expect(BigInt(refreshed.body.availableBalance)).toBeGreaterThan(0n);
    await get('/v1/admin/banks', s.token).expect(200);

    const res = await post('/v1/admin/payouts', s.token, {
      account: 'unimak-fee-tuition', amount: '50000', bankProviderId: 'slb001', accountNumber: '0011223344', accountName: 'University of Makeni', idempotencyKey: 'admin-payout-0001',
    }).expect(201);
    expect(res.body).toMatchObject({ status: 'SUBMITTED', amount: '50000' });
    const audit = await get(`/v1/admin/audit-log?entity=Payout&entityId=${res.body.id}`, s.token).expect(200);
    expect(audit.body.items[0]).toMatchObject({ action: 'payout.request', after: expect.objectContaining({ amount: '50000' }) });
  });

  it('retries a failed commission transfer with a new idempotency key', async () => {
    const paymentId = await pay('student', 'UNI-2026-0008', '+23288200008', 'TUITION', '160000');
    const t = await prisma.transfer.findUniqueOrThrow({ where: { paymentId } });
    await http.post('/dev/monime/simulate-webhook').send({ transferId: t.id, outcome: 'failed' }).expect(200);
    // commission transfers are super-admin only unless granted
    const plain = await admin('BURSAR');
    await post(`/v1/admin/transfers/${t.id}/retry`, plain.token).expect(403);
    await get(`/v1/admin/transfers/${t.id}`, plain.token).expect(403);
    const b = await admin('BURSAR', { extra: ['transfers.read', 'transfers.retry'] });
    const retried = await post(`/v1/admin/transfers/${t.id}/retry`, b.token).expect(200);
    expect(retried.body).toMatchObject({ status: 'SUBMITTED', attempt: 2, monimeTransferId: `trn-mock-commission-${paymentId}-2`.slice(0, 64) });
    await post(`/v1/admin/transfers/${t.id}/retry`, b.token).expect(409); // not FAILED any more
  });

  it('retries DEAD outbox messages', async () => {
    const msg = await prisma.outboxMessage.findFirstOrThrow({ where: { type: 'monime.commission_transfer', status: 'SENT' } }); // re-sending is idempotent on the payment
    await prisma.outboxMessage.update({ where: { id: msg.id }, data: { status: 'DEAD', attempts: 6 } });
    // commission-transfer messages are hidden from admins who can't see commission transfers
    const b = await admin('BURSAR');
    await get(`/v1/admin/outbox/${msg.id}`, b.token).expect(404);
    await post(`/v1/admin/outbox/${msg.id}/retry`, b.token).expect(404);
    const listed = await get('/v1/admin/outbox?status=DEAD', b.token).expect(200);
    expect(listed.body.items.some((m: { type: string }) => m.type === 'monime.commission_transfer')).toBe(false);
    const summary = await get('/v1/admin/reconciliation', b.token).expect(200);
    expect(summary.body).toMatchObject({ failedTransfers: null, stuckTransfers: null, counts: { failedTransfers: null, stuckTransfers: null } });
    expect(summary.body.deadOutbox.some((m: { type: string }) => m.type === 'monime.commission_transfer')).toBe(false);

    const s = await admin('SUPER_ADMIN');
    const res = await post(`/v1/admin/outbox/${msg.id}/retry`, s.token).expect(200);
    expect(res.body.status).toBe('SENT');
  });

  it('reconciliation lists unmatched webhook events; resolving is audited', async () => {
    const paymentId = await pay('applicant', 'APP-2026-0005', '+23230100005', 'APP', '15000');
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    // a second Monime payment for the same, already settled payment
    const dup = await monimeEvent(http, 'payment.processing_completed', { id: 'pay-dup', type: 'payment' }, {
      id: 'pay-dup', status: 'completed', amount: { currency: 'SLE', value: 15000 }, reference: p.id,
    }, 'wke-dup-1').expect(200);
    expect(dup.body.result).toBe('UNMATCHED');

    const b = await admin('BURSAR');
    const summary = await get('/v1/admin/reconciliation', b.token).expect(200);
    expect(summary.body.webhookEvents.map((e: { id: string }) => e.id)).toContain('wke-dup-1');
    await post('/v1/admin/reconciliation/webhook-events/wke-dup-1/resolve', b.token, { resolution: 'Refunded the payer manually' }).expect(200);
    const after = await get('/v1/admin/reconciliation', b.token).expect(200);
    expect(after.body.webhookEvents.map((e: { id: string }) => e.id)).not.toContain('wke-dup-1');
    await post('/v1/admin/reconciliation/webhook-events/wke-dup-1/resolve', b.token, { resolution: 'again' }).expect(409);

    const f = await admin('FINANCE_OFFICER');
    await post('/v1/admin/reconciliation/webhook-events/wke-dup-1/resolve', f.token, { resolution: 'nope' }).expect(403);
  });

  it('audit log is append-only at the database level', async () => {
    const row = await prisma.auditLog.findFirstOrThrow();
    await expect(prisma.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } })).rejects.toThrow(/append-only/);
  });
});
