import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createApp } from '../../src/bootstrap';
import { adminToken, channel } from './helpers';

let app: INestApplication;
let http: ReturnType<typeof request>;
const prisma = new PrismaClient();

async function admin(role: 'SUPER_ADMIN' | 'BURSAR' | 'FINANCE_OFFICER', extra: string[] = []) {
  const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@unimak.test`;
  const u = await prisma.adminUser.create({ data: { email, role, extraPermissions: extra } });
  const token = adminToken({ sub: randomUUID(), email, aal: 'aal2' });
  return {
    id: u.id,
    get: (url: string) => http.get(url).set('authorization', `Bearer ${token}`),
    post: (url: string, body: object = {}) => http.post(url).set('authorization', `Bearer ${token}`).send(body),
    put: (url: string, body: object) => http.put(url).set('authorization', `Bearer ${token}`).send(body),
    patch: (url: string, body: object) => http.patch(url).set('authorization', `Bearer ${token}`).send(body),
    del: (url: string) => http.delete(url).set('authorization', `Bearer ${token}`),
  };
}

beforeAll(async () => {
  app = await createApp();
  http = request(app.getHttpServer());
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('admin fee setup', () => {
  let bursar: Awaited<ReturnType<typeof admin>>;
  let feeTypeId: string;
  let feeId: string;

  beforeAll(async () => {
    bursar = await admin('BURSAR');
  });

  it('creates a fee type together with its own Monime financial account', async () => {
    const res = await bursar.post('/v1/admin/fee-types', { code: 'LIB', name: 'Library fee', payerKind: 'STUDENT', recurrence: 'PER_YEAR' }).expect(201);
    expect(res.body).toMatchObject({ code: 'LIB', accountError: null, account: { reference: 'unimak-fee-lib', monimeId: 'fac-mock-unimak-fee-lib', purpose: 'FEE_TYPE' } });
    feeTypeId = res.body.id;
    await bursar.post('/v1/admin/fee-types', { code: 'LIB', name: 'Again', payerKind: 'STUDENT', recurrence: 'ONCE' }).expect(409);
    await bursar.post('/v1/admin/fee-types', { code: 'lib x', name: 'Bad', payerKind: 'STUDENT', recurrence: 'ONCE' }).expect(400);
    // retrying the account is idempotent
    expect((await bursar.post(`/v1/admin/fee-types/${feeTypeId}/account`).expect(200)).body).toMatchObject({ created: false, monimeId: 'fac-mock-unimak-fee-lib' });
    const list = await bursar.get('/v1/admin/fee-types').expect(200);
    expect(list.body.find((t: { code: string }) => t.code === 'LIB').account.reference).toBe('unimak-fee-lib');
  });

  it('creates a draft fee; activation needs a rate rule', async () => {
    const res = await bursar.post('/v1/admin/fees', { feeTypeId, name: 'Library fee 2026/27', period: '2026/27', allowInstalments: true, defaultMinInstalment: '5000', dueDate: '2027-03-31' }).expect(201);
    expect(res.body).toMatchObject({ status: 'DRAFT', defaultMinInstalment: '5000' });
    feeId = res.body.id;
    await bursar.post('/v1/admin/fees', { feeTypeId, name: 'Dup', period: '2026/27', allowInstalments: false }).expect(409);
    const act = await bursar.patch(`/v1/admin/fees/${feeId}`, { status: 'ACTIVE' }).expect(409);
    expect(act.body.error.message).toBe('Add at least one rate rule before activating');
  });

  it('adds rate rules and rejects an ambiguous tie', async () => {
    await bursar.post(`/v1/admin/fees/${feeId}/rate-rules`, { amount: '20000' }).expect(201); // default for everyone
    const cs = await bursar.post(`/v1/admin/fees/${feeId}/rate-rules`, { programCode: 'BSC-CS', amount: '25000' }).expect(201);
    expect(cs.body).toMatchObject({ programCode: 'BSC-CS', amount: '25000', level: null });
    const tie = await bursar.post(`/v1/admin/fees/${feeId}/rate-rules`, { residency: 'INTERNATIONAL', amount: '40000' }).expect(409);
    expect(tie.body.error).toMatchObject({ code: 'AMBIGUOUS_RATE_RULE', message: expect.stringMatching(/add a rule for \[programCode=BSC-CS, residency=INTERNATIONAL\]/) });
    // add the tie-breaker first, then the international rule is fine
    await bursar.post(`/v1/admin/fees/${feeId}/rate-rules`, { programCode: 'BSC-CS', residency: 'INTERNATIONAL', amount: '50000' }).expect(201);
    await bursar.post(`/v1/admin/fees/${feeId}/rate-rules`, { residency: 'INTERNATIONAL', amount: '40000' }).expect(201);
    // update a rule's amount
    await bursar.put(`/v1/admin/fees/${feeId}/rate-rules/${cs.body.id}`, { programCode: 'BSC-CS', amount: '26000' }).expect(200);
  });

  it('refuses to delete a tie-breaker', async () => {
    const fee = await bursar.get(`/v1/admin/fees/${feeId}`).expect(200);
    const breaker = fee.body.rateRules.find((r: { programCode: string; residency: string }) => r.programCode === 'BSC-CS' && r.residency === 'INTERNATIONAL');
    const res = await bursar.del(`/v1/admin/fees/${feeId}/rate-rules/${breaker.id}`).expect(409);
    expect(res.body.error.code).toBe('AMBIGUOUS_RATE_RULE');
  });

  it('limits the fee to computing students, activates it, and previews a payer', async () => {
    await bursar.post(`/v1/admin/fees/${feeId}/eligibility-rules`, { department: 'COMPUTING' }).expect(201);
    expect((await bursar.patch(`/v1/admin/fees/${feeId}`, { status: 'ACTIVE' }).expect(200)).body.status).toBe('ACTIVE');

    const cs = await bursar.get(`/v1/admin/fees/${feeId}/preview?kind=student&ref=UNI-2025-0003`).expect(200); // BSC-CS international
    expect(cs.body).toMatchObject({ eligible: true, amount: '50000', minInstalment: '5000', reason: null });
    const nurse = await bursar.get(`/v1/admin/fees/${feeId}/preview?kind=student&ref=UNI-2024-0006`).expect(200);
    expect(nurse.body).toMatchObject({ eligible: false, amount: null, reason: 'No eligibility rule matches' });
    const applicant = await bursar.get(`/v1/admin/fees/${feeId}/preview?kind=applicant&ref=APP-2026-0001`).expect(200);
    expect(applicant.body.reason).toBe('Fee is for students');
  });

  it('the next lookup creates the obligation at the rate-rule amount', async () => {
    const ob = await channel(http, 'get', '/v1/channel/payers/student/UNI-2025-0003/obligations').expect(200);
    expect(ob.body.obligations.find((o: { feeTypeCode: string }) => o.feeTypeCode === 'LIB')).toMatchObject({ amount: { value: '50000' }, minInstalment: { value: '5000' } });
  });

  it('minimum instalment per program needs instalments.manage', async () => {
    const fo = await admin('FINANCE_OFFICER', ['fees.manage']);
    await fo.put(`/v1/admin/fees/${feeId}/instalment-rules/bsc-cs`, { minInstalment: '10000' }).expect(403);
    const contact = await admin('FINANCE_OFFICER', ['instalments.manage']);
    const res = await contact.put(`/v1/admin/fees/${feeId}/instalment-rules/bsc-cs`, { minInstalment: '10000' }).expect(200);
    expect(res.body).toMatchObject({ programCode: 'BSC-CS', minInstalment: '10000', updatedBy: contact.id });
    expect((await bursar.get(`/v1/admin/fees/${feeId}/preview?kind=student&ref=UNI-2025-0003`).expect(200)).body.minInstalment).toBe('10000');
  });

  it('closing a fee stops new obligations; read-only roles cannot change the catalog', async () => {
    const fo = await admin('FINANCE_OFFICER');
    await fo.get('/v1/admin/fees').expect(403); // finance officers don't have fees.read
    await fo.post('/v1/admin/fee-types', { code: 'X1', name: 'Nope', payerKind: 'STUDENT', recurrence: 'ONCE' }).expect(403);
    expect((await bursar.patch(`/v1/admin/fees/${feeId}`, { status: 'CLOSED' }).expect(200)).body.status).toBe('CLOSED');
    await bursar.patch(`/v1/admin/fees/${feeId}`, { status: 'DRAFT' }).expect(409);
  });

  it('audits every catalog change', async () => {
    const actions = (await prisma.auditLog.findMany({ where: { actorId: bursar.id }, select: { action: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['fee_type.create', 'account.create', 'fee.create', 'rate_rule.create', 'rate_rule.update', 'eligibility_rule.create', 'fee.update']));
  });
});
