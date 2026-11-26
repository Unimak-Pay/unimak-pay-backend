import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createApp } from '../../src/bootstrap';
import { PORTAL_CLIENT, type PortalClient } from '../../src/modules/integrations/portal/portal.port';
import { PAYER_REPOSITORY, type PayerRepository } from '../../src/modules/payers/application/payer.repository';
import { ProvisionAccountsUseCase } from '../../src/modules/treasury/application/provision-accounts.use-case';
import { adminToken, channel, portal } from './helpers';
import { TEST_CRON_SECRET, TEST_PORTAL_SECRET_OLD } from './test-env';

let app: INestApplication;
let http: ReturnType<typeof request>;
const prisma = new PrismaClient();
let getStudent: jest.SpyInstance;

/** Refs only this file uses (not in the portal fixtures: they exist only through events). */
const S1 = 'UNI-2026-0201';
const S2 = 'UNI-2026-0202';
const S3 = 'UNI-2026-0203';
const A1 = 'APP-2026-0201';
const NEW_TO_US = 'UNI-2026-0299';

let seq = 0;
const eid = () => `evt-e2e-${Date.now()}-${++seq}`;
const student = (studentId: string, over: Record<string, unknown> = {}) => ({
  studentId, applicationRef: null, fullName: `Portal ${studentId}`, phone: `+232762${studentId.slice(-5).replace('-', '0')}`,
  programCode: 'BSC-CS', department: 'COMPUTER-SCI', level: 1, finalYear: false, residency: 'LOCAL', intake: '2026-SEP',
  enrolmentStatus: 'ACTIVE', updatedAt: '2026-11-21T09:00:00.000Z', ...over,
});
const sEvent = (data: object, id = eid()) => ({ id, type: 'student.upserted', occurredAt: '2026-11-21T09:00:00Z', data });
const send = (events: object[]) => portal(http, 'post', '/v1/portal/events', { events });
const feeCodes = async (ref: string) =>
  (await prisma.obligation.findMany({ where: { payer: { ref } }, include: { fee: { include: { feeType: true } } } })).map((o) => o.fee.feeType.code).sort();

async function admin(role: 'BURSAR' | 'FINANCE_OFFICER' | 'HEAD_OF_DEPARTMENT', departments: string[] = []) {
  const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@unimak.test`;
  await prisma.adminUser.create({ data: { email, role, departments } });
  const token = adminToken({ sub: randomUUID(), email, aal: 'aal2' });
  return { get: (url: string) => http.get(url).set('authorization', `Bearer ${token}`) };
}

beforeAll(async () => {
  app = await createApp();
  http = request(app.getHttpServer());
  await app.get(ProvisionAccountsUseCase).execute();
  const client = app.get<PortalClient>(PORTAL_CLIENT);
  const real = client.getStudent.bind(client);
  // NEW_TO_US exists only in the portal: never sent as an event or looked up by another file
  getStudent = jest.spyOn(client, 'getStudent').mockImplementation(async (ref) =>
    ref === NEW_TO_US
      ? { studentId: ref, fullName: 'Portal Only', phone: '+23276202990', programCode: 'BSC-CS', department: 'COMPUTER-SCI', level: 1, finalYear: false, residency: 'LOCAL', intake: '2026-SEP' }
      : real(ref),
  );
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('POST /v1/portal/events: signing and envelope', () => {
  it('needs a valid signature and a fresh timestamp', async () => {
    const body = { events: [sEvent(student(S3))] };
    await http.post('/v1/portal/events').send(body).expect(401);
    await portal(http, 'post', '/v1/portal/events', body, { secret: 'wrong-secret-0123456789abcdef0123456789' }).expect(401);
    await portal(http, 'post', '/v1/portal/events', body, { ts: Math.floor(Date.now() / 1000) - 301 }).expect(401);
    expect(await prisma.portalEvent.count({ where: { ref: S3 } })).toBe(0);
  });

  it('accepts the previous secret while rotating', async () => {
    const res = await portal(http, 'post', '/v1/portal/events', { events: [sEvent(student(S3))] }, { secret: TEST_PORTAL_SECRET_OLD }).expect(200);
    expect(res.body.results[0].result).toBe('APPLIED');
  });

  it('rejects a malformed batch as a whole', async () => {
    await portal(http, 'post', '/v1/portal/events', { nope: [] }).expect(400);
    await send([]).expect(400);
    await send(Array.from({ length: 501 }, () => sEvent(student(S3)))).expect(400);
    const badId = await send([{ ...sEvent(student(S3)), id: 'has spaces' }]).expect(400);
    expect(badId.body.message).toBe('events[0].id must be 1-100 letters, digits or _ . : -');
    const e = sEvent(student(S3));
    await send([e, e]).expect(400);
  });
});

describe('applying events', () => {
  it('stores a new student and bills them at once (no lookup needed)', async () => {
    const id = eid();
    const res = await send([sEvent(student(S1, { applicationRef: 'APP-2026-0001' }), id)]).expect(200);
    expect(res.body).toEqual({ results: [{ id, result: 'APPLIED' }] });

    const p = await prisma.payer.findUniqueOrThrow({ where: { kind_ref: { kind: 'STUDENT', ref: S1 } } });
    expect(p).toMatchObject({ level: 1, enrolmentStatus: 'ACTIVE', applicationRef: 'APP-2026-0001', portalUpdatedAt: new Date('2026-11-21T09:00:00.000Z') });
    expect(await feeCodes(S1)).toEqual(expect.arrayContaining(['DEPT', 'TUITION']));
    const charge = await prisma.ledgerEntry.findFirstOrThrow({ where: { obligation: { payer: { ref: S1 } }, type: 'CHARGE' } });
    expect(charge.createdBy).toBe('system:portal-event');
  });

  it('per-event results: duplicate id, older version, invalid record', async () => {
    const dupId = eid();
    await send([sEvent(student(S1, { level: 1, updatedAt: '2026-11-21T09:30:00.000Z' }), dupId)]).expect(200);
    const res = await send([
      sEvent(student(S1), dupId), // same id again
      sEvent(student(S1, { level: 3, updatedAt: '2026-11-21T08:00:00.000Z' })), // older than what we hold
      sEvent(student(S1, { level: 3, updatedAt: '2026-11-21T09:30:00.000Z' })), // same version
      sEvent(student(S2, { level: 0, phone: '0762' })),
    ]).expect(200);
    expect(res.body.results.map((r: { result: string }) => r.result)).toEqual(['DUPLICATE', 'STALE', 'STALE', 'REJECTED']);
    expect(res.body.results[3].error).toEqual({ code: 'VALIDATION', message: 'phone must be in international format, e.g. +23276123456; level must be a whole number from 1 to 10' });
    expect((await prisma.payer.findUniqueOrThrow({ where: { kind_ref: { kind: 'STUDENT', ref: S1 } } })).level).toBe(1);
    expect(await prisma.portalEvent.findFirstOrThrow({ where: { ref: S2, result: 'REJECTED' } })).toMatchObject({ type: 'student.upserted', error: expect.stringContaining('level must be') });
  });

  it('a newer version updates the record; an unknown department is flagged for review', async () => {
    await send([sEvent(student(S2, { department: 'PORTAL-NEW-DEPT', level: 2, updatedAt: '2026-11-21T10:00:00.000Z' }))]).expect(200);
    expect(await prisma.department.findUniqueOrThrow({ where: { code: 'PORTAL-NEW-DEPT' } })).toMatchObject({ needsReview: true, facultyId: null });
    // the database is shared across test files (academics expects its own review list): place it
    const faculty = await prisma.faculty.findUniqueOrThrow({ where: { code: 'FAC-PURE-SCI' } });
    await prisma.department.update({ where: { code: 'PORTAL-NEW-DEPT' }, data: { needsReview: false, facultyId: faculty.id } });
    await send([sEvent(student(S2, { department: 'COMPUTER-SCI', level: 2, updatedAt: '2026-11-21T10:05:00.000Z' }))]).expect(200);
    expect(await prisma.payer.findUniqueOrThrow({ where: { kind_ref: { kind: 'STUDENT', ref: S2 } } })).toMatchObject({ department: 'COMPUTER-SCI', level: 2 });
  });

  it('an applicant gets the application fee as soon as the event arrives', async () => {
    const res = await send([{
      id: eid(), type: 'applicant.upserted', occurredAt: '2026-11-21T09:00:00Z',
      data: { applicationRef: A1, fullName: 'Portal Applicant', phone: '+23276100201', programCode: 'BSC-CS', department: 'COMPUTER-SCI', intake: '2026-SEP', residency: 'LOCAL', status: 'APPLIED', updatedAt: '2026-11-21T09:00:00Z' },
    }]).expect(200);
    expect(res.body.results[0].result).toBe('APPLIED');
    expect(await feeCodes(A1)).toEqual(['APP']);
  });
});

describe('students who are not active', () => {
  it('a student who arrives withdrawn gets no charges', async () => {
    await send([sEvent(student('UNI-2026-0204', { enrolmentStatus: 'WITHDRAWN' }))]).expect(200);
    expect(await feeCodes('UNI-2026-0204')).toEqual([]);
  });

  it('keeps what a suspended student owes payable, and lists them for review (scoped)', async () => {
    await send([sEvent(student(S1, { enrolmentStatus: 'SUSPENDED', updatedAt: '2026-11-21T11:00:00.000Z' }))]).expect(200);
    const ob = await channel(http, 'get', `/v1/channel/payers/student/${S1}/obligations`).expect(200);
    const tuition = ob.body.obligations.find((o: { feeTypeCode: string }) => o.feeTypeCode === 'TUITION');
    expect(tuition.status).toBe('OPEN');
    await channel(http, 'post', '/v1/channel/quotes', { obligationId: tuition.id, amount: tuition.minInstalment.value, channel: 'USSD' }).expect(200);

    const bursar = await admin('BURSAR');
    const list = await bursar.get('/v1/admin/payers/needs-review').expect(200);
    const row = list.body.items.find((i: { ref: string }) => i.ref === S1);
    expect(row).toMatchObject({ fullName: `Portal ${S1}`, department: 'COMPUTER-SCI', enrolmentStatus: 'SUSPENDED', totalBalance: expect.stringMatching(/^[1-9]\d*$/) });
    expect(row.obligations.map((o: { feeName: string }) => o.feeName)).toEqual(expect.arrayContaining(['Tuition 2026/27']));
    expect((await bursar.get('/v1/admin/payers/needs-review?status=WITHDRAWN').expect(200)).body.items.find((i: { ref: string }) => i.ref === S1)).toBeUndefined();

    const nursingHead = await admin('HEAD_OF_DEPARTMENT', ['NURSING']);
    expect((await nursingHead.get('/v1/admin/payers/needs-review').expect(200)).body.items.find((i: { ref: string }) => i.ref === S1)).toBeUndefined();
    const csHead = await admin('HEAD_OF_DEPARTMENT', ['COMPUTER-SCI']);
    expect((await csHead.get('/v1/admin/payers/needs-review').expect(200)).body.items.find((i: { ref: string }) => i.ref === S1)).toBeDefined();
  });
});

describe('lookups read our store first', () => {
  it('no portal call for a student we hold', async () => {
    getStudent.mockClear();
    const res = await channel(http, 'get', `/v1/channel/payers/student/${S2}`).expect(200);
    expect(res.body).toMatchObject({ ref: S2, stale: false });
    expect(getStudent).not.toHaveBeenCalled();
  });

  it('the portal for someone we have never seen', async () => {
    getStudent.mockClear();
    await channel(http, 'get', `/v1/channel/payers/student/${NEW_TO_US}`).expect(200);
    expect(getStudent).toHaveBeenCalledWith(NEW_TO_US);
    // stored now: the next lookup doesn't ask again
    getStudent.mockClear();
    await channel(http, 'get', `/v1/channel/payers/student/${NEW_TO_US}`).expect(200);
    expect(getStudent).not.toHaveBeenCalled();
  });

  it('a record not refreshed for 30 days is refreshed; if the portal lacks it, ours is served', async () => {
    await prisma.payer.update({ where: { kind_ref: { kind: 'STUDENT', ref: S2 } }, data: { snapshotAt: new Date(Date.now() - 31 * 24 * 60 * 60_000) } });
    getStudent.mockClear();
    const res = await channel(http, 'get', `/v1/channel/payers/student/${S2}`).expect(200);
    expect(getStudent).toHaveBeenCalledWith(S2); // the mock portal has no such student → 404 → stored record
    expect(res.body).toMatchObject({ ref: S2, stale: false });
    // a lookup never clears what an event set
    expect(await prisma.payer.findUniqueOrThrow({ where: { kind_ref: { kind: 'STUDENT', ref: S2 } } })).toMatchObject({ enrolmentStatus: 'ACTIVE' });
  });
});

describe('summary, admin log, retention', () => {
  it('GET /v1/portal/summary gives our counts (signed)', async () => {
    await http.get('/v1/portal/summary').expect(401);
    const res = await portal(http, 'get', '/v1/portal/summary').expect(200);
    expect(res.body).toMatchObject({ asOf: expect.any(String), lastEventAt: expect.any(String) });
    expect(res.body.students).toEqual(expect.arrayContaining([expect.objectContaining({ department: 'COMPUTER-SCI', level: 1, enrolmentStatus: 'SUSPENDED', count: expect.any(Number) })]));
    expect(res.body.applicants).toEqual(expect.arrayContaining([expect.objectContaining({ department: 'COMPUTER-SCI', status: 'APPLIED' })]));
  });

  it('the event log needs portal.read', async () => {
    await (await admin('FINANCE_OFFICER')).get('/v1/admin/portal-events').expect(403);
    const bursar = await admin('BURSAR');
    const rejected = await bursar.get('/v1/admin/portal-events?result=REJECTED').expect(200);
    expect(rejected.body.items.every((e: { result: string }) => e.result === 'REJECTED')).toBe(true);
    expect(rejected.body.items.map((e: { ref: string }) => e.ref)).toContain(S2);
    expect(rejected.body.lastAppliedAt).toEqual(expect.any(String));
    const page1 = await bursar.get(`/v1/admin/portal-events?ref=${S1}&limit=1`).expect(200);
    expect(page1.body.items).toHaveLength(1);
    const page2 = await bursar.get(`/v1/admin/portal-events?ref=${S1}&limit=1&cursor=${page1.body.nextCursor}`).expect(200);
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
  });

  it('events older than 90 days are purged by the cleanup cron', async () => {
    const old = await prisma.portalEvent.create({ data: { id: eid(), type: 'student.upserted', ref: S3, result: 'APPLIED', data: {}, receivedAt: new Date(Date.now() - 91 * 24 * 60 * 60_000) } });
    const res = await http.get('/cron/expire-payments').set('authorization', `Bearer ${TEST_CRON_SECRET}`).expect(200);
    expect(res.body.portalEventsDeleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.portalEvent.findUnique({ where: { id: old.id } })).toBeNull();
  });
});

describe('email on the record (optional)', () => {
  const S = 'UNI-2026-0205';
  const emailOf = async () => (await prisma.payer.findUniqueOrThrow({ where: { kind_ref: { kind: 'STUDENT', ref: S } } })).email;
  const at = (min: number) => `2026-11-27T09:${String(min).padStart(2, '0')}:00.000Z`;

  it('an event sets it; leaving it out keeps it; null clears it', async () => {
    await send([sEvent(student(S, { email: ' Abdul.Koroma@Example.com ', updatedAt: at(1) }))]).expect(200);
    expect(await emailOf()).toBe('Abdul.Koroma@Example.com');
    await send([sEvent(student(S, { level: 2, updatedAt: at(2) }))]).expect(200);
    expect(await emailOf()).toBe('Abdul.Koroma@Example.com');
    await send([sEvent(student(S, { email: null, updatedAt: at(3) }))]).expect(200);
    expect(await emailOf()).toBeNull();
  });

  it('a bad email rejects only that event', async () => {
    const res = await send([sEvent(student(S, { email: 'not-an-email', updatedAt: at(4) }))]).expect(200);
    expect(res.body.results[0]).toMatchObject({ result: 'REJECTED', error: { message: expect.stringContaining('email must be') } });
  });

  it('a portal lookup without an email never clears one', async () => {
    await send([sEvent(student(S, { email: 'abdul@example.com', updatedAt: at(5) }))]).expect(200);
    const repo = app.get<PayerRepository>(PAYER_REPOSITORY);
    const p = (await repo.find('STUDENT', S))!;
    await repo.upsertSnapshot({ ...p, email: undefined }, new Date());
    expect(await emailOf()).toBe('abdul@example.com');
    await repo.upsertSnapshot({ ...p, email: null }, new Date()); // a lookup's null means "not said"
    expect(await emailOf()).toBe('abdul@example.com');
  });
});
