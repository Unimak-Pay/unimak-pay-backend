import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createApp } from '../../src/bootstrap';
import { PORTAL_CLIENT, type PortalClient } from '../../src/modules/integrations/portal/portal.port';
import { ProvisionAccountsUseCase } from '../../src/modules/treasury/application/provision-accounts.use-case';
import { adminToken, channel } from './helpers';

let app: INestApplication;
let http: ReturnType<typeof request>;
const prisma = new PrismaClient();

/** Students only this file uses; programme BSC-REP keeps this file's fee away from everyone else. */
const UNPAID = 'UNI-2026-0094';
const PART_PAID = 'UNI-2026-0095';
const IN_PROGRESS = 'UNI-2026-0096';
const phone = (ref: string) => `+232762000${ref.slice(-2)}`;

async function admin(role: 'SUPER_ADMIN' | 'BURSAR' | 'FINANCE_OFFICER' | 'HEAD_OF_DEPARTMENT') {
  const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@unimak.test`;
  const u = await prisma.adminUser.create({ data: { email, role, departments: role === 'HEAD_OF_DEPARTMENT' ? ['COMPUTER-SCI'] : [] } });
  const token = adminToken({ sub: randomUUID(), email, aal: 'aal2' });
  return {
    id: u.id,
    get: (url: string) => http.get(url).set('authorization', `Bearer ${token}`),
    post: (url: string, body: object = {}) => http.post(url).set('authorization', `Bearer ${token}`).send(body),
    put: (url: string, body: object) => http.put(url).set('authorization', `Bearer ${token}`).send(body),
    patch: (url: string, body: object) => http.patch(url).set('authorization', `Bearer ${token}`).send(body),
  };
}

const obligationOf = async (ref: string) => {
  const res = await channel(http, 'get', `/v1/channel/payers/student/${ref}/obligations`).expect(200);
  return res.body.obligations.find((o: { feeTypeCode: string }) => o.feeTypeCode === 'REP');
};

beforeAll(async () => {
  app = await createApp();
  http = request(app.getHttpServer());
  await app.get(ProvisionAccountsUseCase).execute();
  const portal = app.get<PortalClient>(PORTAL_CLIENT);
  const real = portal.getStudent.bind(portal);
  jest.spyOn(portal, 'getStudent').mockImplementation(async (ref) =>
    [UNPAID, PART_PAID, IN_PROGRESS].includes(ref)
      ? { studentId: ref, fullName: `Student ${ref}`, phone: phone(ref), programCode: 'BSC-REP', department: 'COMPUTER-SCI', level: 1, finalYear: false, residency: 'LOCAL', intake: '2026-SEP' }
      : real(ref),
  );
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('re-pricing a fee after its rate rule changed', () => {
  let bursar: Awaited<ReturnType<typeof admin>>;
  let feeId: string;
  let ruleId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    bursar = await admin('BURSAR');
    const ft = await bursar.post('/v1/admin/fee-types', { code: 'REP', name: 'Re-price test fee', payerKind: 'STUDENT', recurrence: 'PER_YEAR' }).expect(201);
    const fee = await bursar.post('/v1/admin/fees', { feeTypeId: ft.body.id, name: 'Re-price test 2026/27', period: '2026/27', allowInstalments: true, defaultMinInstalment: '1000' }).expect(201);
    feeId = fee.body.id;
    ruleId = (await bursar.post(`/v1/admin/fees/${feeId}/rate-rules`, { programCode: 'BSC-REP', amount: '30000' }).expect(201)).body.id;
    await bursar.post(`/v1/admin/fees/${feeId}/eligibility-rules`, { programCode: 'BSC-REP' }).expect(201);
    await bursar.patch(`/v1/admin/fees/${feeId}`, { status: 'ACTIVE' }).expect(200);

    for (const ref of [UNPAID, PART_PAID, IN_PROGRESS]) ids[ref] = (await obligationOf(ref)).id;
    // one part-paid, one with a payment still pending
    const part = await channel(http, 'post', '/v1/channel/payments', { obligationId: ids[PART_PAID], amount: '10000', payerPhone: phone(PART_PAID), channel: 'USSD', idempotencyKey: 'reprice-part-1' }).expect(201);
    await http.post('/dev/monime/simulate-webhook').send({ paymentId: part.body.paymentId, outcome: 'completed' }).expect(200);
    await channel(http, 'post', '/v1/channel/payments', { obligationId: ids[IN_PROGRESS], amount: '5000', payerPhone: phone(IN_PROGRESS), channel: 'USSD', idempotencyKey: 'reprice-pending-1' }).expect(201);

    await bursar.put(`/v1/admin/fees/${feeId}/rate-rules/${ruleId}`, { programCode: 'BSC-REP', amount: '20000' }).expect(200);
  });

  it('a rule change alone does not touch existing obligations', async () => {
    expect((await obligationOf(UNPAID)).amount.value).toBe('30000');
  });

  it('previews without writing', async () => {
    const res = await bursar.get(`/v1/admin/fees/${feeId}/reprice`).expect(200);
    expect(res.body).toEqual({
      fee: { id: feeId, name: 'Re-price test 2026/27' },
      applied: false,
      changes: [{ obligationId: ids[UNPAID], payer: { kind: 'student', ref: UNPAID, fullName: `Student ${UNPAID}` }, current: '30000', proposed: '20000', difference: '-10000', rateRuleId: ruleId }],
      skipped: expect.arrayContaining([
        expect.objectContaining({ obligationId: ids[PART_PAID], current: '30000', reason: 'HAS_PAYMENTS' }),
        expect.objectContaining({ obligationId: ids[IN_PROGRESS], current: '30000', reason: 'PAYMENT_IN_PROGRESS' }),
      ]),
      unchanged: 0,
      totals: { obligations: 3, changed: 1, difference: '-10000' },
    });
    expect((await obligationOf(UNPAID)).amount.value).toBe('30000');
  });

  it('only fee managers can preview or apply', async () => {
    const hod = await admin('HEAD_OF_DEPARTMENT');
    await hod.get(`/v1/admin/fees/${feeId}/reprice`).expect(403);
    const fo = await admin('FINANCE_OFFICER');
    await fo.post(`/v1/admin/fees/${feeId}/reprice`).expect(403);
    await bursar.get(`/v1/admin/fees/${randomUUID()}/reprice`).expect(404);
  });

  it('applies with an ADJUSTMENT ledger entry, audited; paid and in-progress ones are untouched', async () => {
    const res = await bursar.post(`/v1/admin/fees/${feeId}/reprice`).expect(200);
    expect(res.body).toMatchObject({ applied: true, totals: { changed: 1, difference: '-10000' } });

    expect(await obligationOf(UNPAID)).toMatchObject({ amount: { value: '20000' }, balance: { value: '20000' }, payable: { value: '20000' } });
    expect(await obligationOf(PART_PAID)).toMatchObject({ amount: { value: '30000' }, paid: { value: '10000' }, balance: { value: '20000' } });
    expect((await obligationOf(IN_PROGRESS)).amount.value).toBe('30000');

    const entries = await prisma.ledgerEntry.findMany({ where: { obligationId: ids[UNPAID] }, orderBy: { createdAt: 'asc' } });
    expect(entries.map((e) => [e.type, e.amount])).toEqual([['CHARGE', 30000n], ['ADJUSTMENT', -10000n]]);
    expect(entries[1]).toMatchObject({ createdBy: `admin:${bursar.id}`, memo: `reprice: 30000 → 20000 (rate rule ${ruleId})` });

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'fee.reprice', entityId: feeId } });
    expect(audit).toMatchObject({ actorId: bursar.id, after: expect.objectContaining({ difference: '-10000' }) });
  });

  it('running it again changes nothing', async () => {
    const res = await bursar.post(`/v1/admin/fees/${feeId}/reprice`).expect(200);
    expect(res.body).toMatchObject({ changes: [], unchanged: 1, totals: { changed: 0, difference: '0' } });
    expect(await prisma.ledgerEntry.count({ where: { obligationId: ids[UNPAID] } })).toBe(2);
  });
});
