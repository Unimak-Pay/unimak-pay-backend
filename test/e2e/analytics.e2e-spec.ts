import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createApp } from '../../src/bootstrap';
import { ProvisionAccountsUseCase } from '../../src/modules/treasury/application/provision-accounts.use-case';
import { adminToken, channel, portal } from './helpers';

let app: INestApplication;
let http: ReturnType<typeof request>;
const prisma = new PrismaClient();

/** Students only this file uses, sent as portal events; programme BSC-ANA keeps this file's fee to them. */
const UNPAID = 'UNI-2026-0401';
const PART = 'UNI-2026-0402';
const PAID = 'UNI-2026-0403';
const NURSE = 'UNI-2026-0404';
const SUSPENDED = 'UNI-2026-0405';
const phone = (ref: string) => `+23276400${ref.slice(-3)}`;

let seq = 0;
const student = (studentId: string, over: Record<string, unknown> = {}) => ({
  id: `evt-ana-${Date.now()}-${++seq}`, type: 'student.upserted', occurredAt: '2026-11-21T09:00:00Z',
  data: {
    studentId, applicationRef: null, fullName: `Analytics ${studentId.slice(-3)}`, phone: phone(studentId), programCode: 'BSC-ANA',
    department: 'COMPUTER-SCI', level: 1, finalYear: false, residency: 'LOCAL', intake: '2026-SEP', enrolmentStatus: 'ACTIVE',
    updatedAt: '2026-11-21T09:00:00.000Z', ...over,
  },
});

async function admin(role: 'BURSAR' | 'HEAD_OF_DEPARTMENT', departments: string[] = []) {
  const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@unimak.test`;
  const u = await prisma.adminUser.create({ data: { email, role, departments } });
  const token = adminToken({ sub: randomUUID(), email, aal: 'aal2' });
  return {
    id: u.id,
    get: (url: string) => http.get(url).set('authorization', `Bearer ${token}`),
    post: (url: string, body: object = {}) => http.post(url).set('authorization', `Bearer ${token}`).send(body),
    patch: (url: string, body: object) => http.patch(url).set('authorization', `Bearer ${token}`).send(body),
  };
}

async function pay(ref: string, feeId: string, amount: string) {
  const o = await prisma.obligation.findFirstOrThrow({ where: { feeId, payer: { ref } } });
  const res = await channel(http, 'post', '/v1/channel/payments', { obligationId: o.id, amount, payerPhone: phone(ref), channel: 'USSD', idempotencyKey: `ana-${ref}-${amount}` }).expect(201);
  await http.post('/dev/monime/simulate-webhook').send({ paymentId: res.body.paymentId, outcome: 'completed' }).expect(200);
}

let bursar: Awaited<ReturnType<typeof admin>>;
let hod: Awaited<ReturnType<typeof admin>>;
let feeId: string;
const payerId: Record<string, string> = {};

beforeAll(async () => {
  app = await createApp();
  http = request(app.getHttpServer());
  await app.get(ProvisionAccountsUseCase).execute();
  bursar = await admin('BURSAR');
  hod = await admin('HEAD_OF_DEPARTMENT', ['COMPUTER-SCI']);

  const ft = await bursar.post('/v1/admin/fee-types', { code: 'ANA', name: 'Analytics test fee', payerKind: 'STUDENT', recurrence: 'PER_YEAR' }).expect(201);
  const fee = await bursar.post('/v1/admin/fees', { feeTypeId: ft.body.id, name: 'Analytics test 2026/27', period: '2026/27', allowInstalments: true, defaultMinInstalment: '1000', dueDate: '2026-10-01T00:00:00Z' }).expect(201);
  feeId = fee.body.id;
  await bursar.post(`/v1/admin/fees/${feeId}/rate-rules`, { programCode: 'BSC-ANA', amount: '30000' }).expect(201);
  await bursar.post(`/v1/admin/fees/${feeId}/eligibility-rules`, { programCode: 'BSC-ANA' }).expect(201);
  await bursar.patch(`/v1/admin/fees/${feeId}`, { status: 'ACTIVE' }).expect(200);

  const sent = await portal(http, 'post', '/v1/portal/events', {
    events: [
      student(UNPAID), student(PART), student(PAID, { level: 2 }), student(NURSE, { department: 'NURSING' }), student(SUSPENDED),
    ],
  }).expect(200);
  expect(sent.body.results.map((r: { result: string }) => r.result)).toEqual(Array(5).fill('APPLIED'));
  // billed while active, suspended afterwards: keeps the charge
  await portal(http, 'post', '/v1/portal/events', { events: [student(SUSPENDED, { enrolmentStatus: 'SUSPENDED', updatedAt: '2026-11-21T10:00:00.000Z' })] }).expect(200);

  await pay(PART, feeId, '10000');
  await pay(PAID, feeId, '30000');
  for (const p of await prisma.payer.findMany({ where: { ref: { in: [UNPAID, PART, PAID, NURSE, SUSPENDED] } } })) payerId[p.ref] = p.id;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

type Cell = { department: string; level: number; students: number; billed: string; collected: string; outstanding: string; paid: number; partPaid: number; unpaid: number; overdue: number; overdueAmount: string; collectionRate: number | null };
const cellOf = (grid: Cell[], department: string, level: number) => grid.find((c) => c.department === department && c.level === level);

describe('GET /v1/admin/reports/outstanding', () => {
  it('breaks a fee down by department × level, leaving inactive students out', async () => {
    const res = await bursar.get(`/v1/admin/reports/outstanding?feeId=${feeId}`).expect(200);
    expect(res.body.totals).toEqual({
      students: 4, billed: '120000', collected: '40000', outstanding: '80000',
      paid: 1, partPaid: 1, unpaid: 2, overdue: 3, overdueAmount: '80000', collectionRate: 0.333,
    });
    expect(res.body.grid).toHaveLength(3);
    expect(cellOf(res.body.grid, 'COMPUTER-SCI', 1)).toMatchObject({
      departmentName: expect.any(String), facultyCode: expect.any(String),
      students: 2, billed: '60000', collected: '10000', outstanding: '50000', paid: 0, partPaid: 1, unpaid: 1, overdue: 2, overdueAmount: '50000', collectionRate: 0.166,
    });
    expect(cellOf(res.body.grid, 'COMPUTER-SCI', 2)).toMatchObject({ students: 1, paid: 1, outstanding: '0', overdue: 0, collectionRate: 1 });
    expect(cellOf(res.body.grid, 'NURSING', 1)).toMatchObject({ students: 1, unpaid: 1, outstanding: '30000' });
    expect(res.body.byFee).toEqual([
      expect.objectContaining({ feeId, feeTypeCode: 'ANA', obligations: 4, billed: '120000', collected: '40000', outstanding: '80000', dueDate: '2026-10-01T00:00:00.000Z' }),
    ]);
    expect(res.body.applicants).toEqual({ byStatus: [] });
    expect(res.body.roster).toEqual({ activeStudents: expect.any(Number), withoutObligations: expect.any(Number), lastPortalEventAt: expect.any(String) });
  });

  it('counts inactive students when asked', async () => {
    const res = await bursar.get(`/v1/admin/reports/outstanding?feeId=${feeId}&includeInactive=true`).expect(200);
    expect(res.body.totals.students).toBe(5);
    expect(cellOf(res.body.grid, 'COMPUTER-SCI', 1)!.students).toBe(3);
  });

  it('filters by department and level', async () => {
    const res = await bursar.get(`/v1/admin/reports/outstanding?feeId=${feeId}&department=COMPUTER-SCI&level=2`).expect(200);
    expect(res.body.grid).toHaveLength(1);
    expect(res.body.totals.students).toBe(1);
  });

  it('heads of department only see their departments', async () => {
    const res = await hod.get(`/v1/admin/reports/outstanding?feeId=${feeId}`).expect(200);
    expect(res.body.filters.departments).toEqual(['COMPUTER-SCI']);
    expect(res.body.grid.map((c: Cell) => c.department)).toEqual(['COMPUTER-SCI', 'COMPUTER-SCI']);
    expect(res.body.totals.students).toBe(3);
  });

  it('validates its filters', async () => {
    await bursar.get('/v1/admin/reports/outstanding?feeId=nope').expect(400);
    await bursar.get('/v1/admin/reports/outstanding?level=11').expect(400);
  });
});

describe('GET /v1/admin/payers', () => {
  const list = async (who: typeof bursar, qs: string) => (await who.get(`/v1/admin/payers?feeId=${feeId}&${qs}`).expect(200)).body;

  it('lists who owes most first, with cursor paging', async () => {
    const first = await list(bursar, 'limit=2');
    expect(first.items.map((r: { ref: string }) => r.ref).sort()).toEqual([UNPAID, NURSE]);
    expect(first.items[0]).toMatchObject({ balance: '30000', standing: 'UNPAID', overdue: true, billed: '30000', collected: '0', maskedPhone: expect.stringMatching(/^\+232\*+\d{3}$/) });
    expect(first.items[0].phone).toBeUndefined();
    const second = await list(bursar, `limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((r: { ref: string }) => r.ref)).toEqual([PART, PAID]);
    expect(second.items[0]).toMatchObject({ standing: 'PART_PAID', balance: '20000', lastPaymentAt: expect.any(String) });
    expect(second.nextCursor).toBeNull();
  });

  it('sorts by name and ref', async () => {
    expect((await list(bursar, 'sort=ref')).items.map((r: { ref: string }) => r.ref)).toEqual([UNPAID, PART, PAID, NURSE]);
    const page1 = await list(bursar, 'sort=name&limit=3');
    const page2 = await list(bursar, `sort=name&limit=3&cursor=${page1.nextCursor}`);
    expect([...page1.items, ...page2.items].map((r: { ref: string }) => r.ref)).toEqual([UNPAID, PART, PAID, NURSE]);
  });

  it('filters by standing, search and status', async () => {
    expect((await list(bursar, 'standing=PART_PAID')).items.map((r: { ref: string }) => r.ref)).toEqual([PART]);
    expect((await list(bursar, 'standing=PAID')).items.map((r: { ref: string }) => r.ref)).toEqual([PAID]);
    expect((await list(bursar, 'standing=OVERDUE')).items).toHaveLength(3);
    expect((await list(bursar, 'q=0403')).items.map((r: { ref: string }) => r.ref)).toEqual([PAID]);
    expect((await list(bursar, 'q=analytics%20404')).items.map((r: { ref: string }) => r.ref)).toEqual([NURSE]);
    expect((await list(bursar, 'enrolmentStatus=SUSPENDED')).items.map((r: { ref: string }) => r.ref)).toEqual([SUSPENDED]);
    expect((await list(bursar, 'includeInactive=true')).items).toHaveLength(5);
  });

  it('shows payers with nothing billed without a fee filter', async () => {
    const res = await bursar.get(`/v1/admin/payers?q=${UNPAID}`).expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].obligations).toBeGreaterThanOrEqual(1);
  });

  it('heads of department only see their departments', async () => {
    expect((await list(hod, 'sort=ref')).items.map((r: { ref: string }) => r.ref)).toEqual([UNPAID, PART, PAID]);
  });

  it('rejects a forged cursor', async () => {
    await bursar.get(`/v1/admin/payers?cursor=${Buffer.from('{"v":"1"}').toString('base64url')}`).expect(400);
    await bursar.get('/v1/admin/payers?standing=LATE').expect(400);
  });
});

describe('GET /v1/admin/payers/export.csv', () => {
  it('exports the list with masked phones, audited', async () => {
    const res = await bursar.get(`/v1/admin/payers/export.csv?feeId=${feeId}&sort=ref`).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toMatch(/^kind,ref,full_name,phone_masked,/);
    expect(lines).toHaveLength(5);
    expect(lines[2]).toContain(`STUDENT,${PART},Analytics 402,'+232*****402,`);
    expect(lines[2]).toContain(',300.00,100.00,200.00,PART_PAID,yes,200.00,');
    expect(res.text).not.toContain(phone(PART));
    expect(await prisma.auditLog.count({ where: { actorId: bursar.id, action: 'payers.export' } })).toBe(1);
  });

  it('needs payments.export', async () => {
    await hod.get(`/v1/admin/payers/export.csv?feeId=${feeId}`).expect(403);
  });
});

describe('GET /v1/admin/payers/:id', () => {
  it('shows the full picture, with the full phone', async () => {
    const res = await bursar.get(`/v1/admin/payers/${payerId[PART]}`).expect(200);
    expect(res.body.payer).toMatchObject({ ref: PART, kind: 'STUDENT', phone: phone(PART), department: 'COMPUTER-SCI', level: 1, enrolmentStatus: 'ACTIVE', departmentName: expect.any(String) });
    expect(res.body.linked).toEqual({ applicant: null, student: null });
    const ob = res.body.obligations.find((o: { fee: { id: string } }) => o.fee.id === feeId);
    expect(ob).toMatchObject({ billed: '30000', collected: '10000', balance: '20000', overdue: true, minInstalment: '1000', status: 'OPEN' });
    expect(ob.entries.map((e: { type: string }) => e.type)).toEqual(['CHARGE', 'PAYMENT']);
    expect(ob.payments).toEqual([expect.objectContaining({ amount: '10000', status: 'COMPLETED', receiptNumber: expect.stringMatching(/^UNIMAK-/) })]);
    expect(res.body.receipts.length).toBeGreaterThanOrEqual(1);
    expect(res.body.portalEvents).toEqual([expect.objectContaining({ type: 'student.upserted', result: 'APPLIED' })]);
    expect(res.body.totals).toMatchObject({ standing: 'PART_PAID', overdue: true });
  });

  it('hides payers outside a head of department’s departments', async () => {
    await hod.get(`/v1/admin/payers/${payerId[NURSE]}`).expect(404);
    await hod.get(`/v1/admin/payers/${payerId[UNPAID]}`).expect(200);
  });

  it('404 for an unknown id, 400 for a malformed one', async () => {
    await bursar.get(`/v1/admin/payers/${randomUUID()}`).expect(404);
    await bursar.get('/v1/admin/payers/nope').expect(400);
  });

  it('needs-review still resolves to its own route', async () => {
    await bursar.get('/v1/admin/payers/needs-review').expect(200);
  });
});
