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

type Role = 'SUPER_ADMIN' | 'BURSAR' | 'FINANCE_OFFICER' | 'HEAD_OF_DEPARTMENT' | 'DEAN' | 'AUDITOR';
async function admin(role: Role, scope: { departments?: string[]; faculties?: string[] } = {}) {
  const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@unimak.test`;
  await prisma.adminUser.create({ data: { email, role, departments: scope.departments ?? [], faculties: scope.faculties ?? [] } });
  return as(adminToken({ sub: randomUUID(), email, aal: 'aal2' }));
}
function as(token: string) {
  const auth = (r: request.Test) => r.set('authorization', `Bearer ${token}`);
  return {
    get: (url: string) => auth(http.get(url)),
    post: (url: string, body: object = {}) => auth(http.post(url)).send(body),
    patch: (url: string, body: object) => auth(http.patch(url)).send(body),
    put: (url: string, body: object) => auth(http.put(url)).send(body),
  };
}

/** Students only this file uses (the fixture students' balances belong to other files). */
const EXTRA_STUDENTS = {
  'UNI-2026-0091': { department: 'COMPUTER-SCI', programCode: 'BSC-CS', phone: '+23276200091' },
  'UNI-2026-0092': { department: 'NURSING', programCode: 'BSC-NUR', phone: '+23276200092' },
  'UNI-2026-0099': { department: 'ENGINEERING', programCode: 'BENG', phone: '+23276200099' },
} as const;

function withExtraStudents(): jest.SpyInstance {
  const portal = app.get<PortalClient>(PORTAL_CLIENT);
  const real = portal.getStudent.bind(portal);
  return jest.spyOn(portal, 'getStudent').mockImplementation(async (ref) => {
    const s = EXTRA_STUDENTS[ref as keyof typeof EXTRA_STUDENTS];
    return s ? { studentId: ref, fullName: `Student ${ref}`, phone: s.phone, programCode: s.programCode, department: s.department, level: 1, finalYear: false, residency: 'LOCAL', intake: '2026-SEP' } : real(ref);
  });
}

async function pay(ref: keyof typeof EXTRA_STUDENTS, feeType: string, amount: string): Promise<string> {
  const phone = EXTRA_STUDENTS[ref].phone;
  const ob = await channel(http, 'get', `/v1/channel/payers/student/${ref}/obligations`).expect(200);
  const o = ob.body.obligations.find((x: { feeTypeCode: string }) => x.feeTypeCode === feeType);
  const res = await channel(http, 'post', '/v1/channel/payments', { obligationId: o.id, amount, payerPhone: phone, channel: 'USSD', idempotencyKey: `acad-${ref}-${feeType}-${amount}` }).expect(201);
  await http.post('/dev/monime/simulate-webhook').send({ paymentId: res.body.paymentId, outcome: 'completed' }).expect(200);
  return res.body.paymentId;
}

beforeAll(async () => {
  app = await createApp();
  http = request(app.getHttpServer());
  await app.get(ProvisionAccountsUseCase).execute();
  withExtraStudents();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('faculties and departments', () => {
  it('starts with the university list; any admin can read it', async () => {
    const hod = await admin('HEAD_OF_DEPARTMENT', { departments: ['NURSING'] });
    const faculties = (await hod.get('/v1/admin/faculties').expect(200)).body as { code: string; departments: { code: string }[] }[];
    expect(faculties.map((f) => f.code)).toEqual(expect.arrayContaining([
      'FAC-AGRIC', 'FAC-COMMERCE', 'FAC-EDUCATION', 'FAC-LAW-HUM', 'FAC-MASSCOM-CS', 'FAC-SOCIAL-SCI', 'FAC-NURSING-AHS', 'FAC-PURE-SCI', 'FAC-POSTGRAD', 'FAC-DIPLOMA',
    ]));
    expect(await prisma.department.count({ where: { faculty: { code: { startsWith: 'FAC-' } }, code: { not: { startsWith: 'D-C' } } } })).toBeGreaterThanOrEqual(44);
    const nursing = faculties.find((f) => f.code === 'FAC-NURSING-AHS')!;
    expect(nursing.departments.map((d) => d.code)).toEqual(['CLIN-PSYCH', 'NURSING', 'PUBLIC-HEALTH']);
    expect(faculties.find((f) => f.code === 'FAC-POSTGRAD')!.departments.map((d) => d.code)).toContain('PG-MBA');

    const dept = (await hod.get('/v1/admin/departments/COMPUTER-SCI').expect(200)).body;
    expect(dept).toMatchObject({ code: 'COMPUTER-SCI', name: 'Computer Science', facultyCode: 'FAC-MASSCOM-CS', active: true, needsReview: false });
    const inFaculty = (await hod.get('/v1/admin/departments?faculty=FAC-COMMERCE').expect(200)).body;
    expect(inFaculty).toHaveLength(5);
    await hod.get('/v1/admin/departments/NOPE').expect(404);
  });

  it('only academics.manage can change it; codes are unique and never change; nothing is deleted', async () => {
    await (await admin('BURSAR')).post('/v1/admin/faculties', { code: 'FAC-X', name: 'X' }).expect(403);
    const s = await admin('SUPER_ADMIN');
    const f = await s.post('/v1/admin/faculties', { code: 'FAC-ENG', name: 'Faculty of Engineering' }).expect(201);
    expect(f.body).toMatchObject({ code: 'FAC-ENG', active: true });
    await s.post('/v1/admin/faculties', { code: 'FAC-ENG', name: 'Again' }).expect(409);
    await s.post('/v1/admin/faculties', { code: 'bad code!', name: 'X' }).expect(400);

    const d = await s.post('/v1/admin/departments', { code: 'CIVIL-ENG', name: 'Civil Engineering', facultyCode: 'FAC-ENG' }).expect(201);
    expect(d.body).toMatchObject({ code: 'CIVIL-ENG', facultyCode: 'FAC-ENG', facultyName: 'Faculty of Engineering' });
    await s.post('/v1/admin/departments', { code: 'X-1', name: 'X', facultyCode: 'FAC-NONE' }).expect(400);

    // a faculty with active departments can't be deactivated
    const busy = await s.patch('/v1/admin/faculties/FAC-ENG', { active: false }).expect(409);
    expect(busy.body.error.message).toMatch(/still has active departments: CIVIL-ENG/);
    await s.patch('/v1/admin/departments/CIVIL-ENG', { name: 'Civil & Structural Engineering', active: false }).expect(200);
    await s.patch('/v1/admin/faculties/FAC-ENG', { active: false }).expect(200);
    // …and an inactive faculty takes no departments
    await s.post('/v1/admin/departments', { code: 'MECH-ENG', name: 'Mechanical', facultyCode: 'FAC-ENG' }).expect(409);
    await s.patch('/v1/admin/departments/CIVIL-ENG', { facultyCode: 'FAC-ENG' }).expect(409);

    expect(await prisma.auditLog.count({ where: { action: { in: ['faculty.create', 'faculty.update', 'department.create', 'department.update'] }, entityId: { in: [f.body.id, d.body.id] } } })).toBe(4);
  });

  it('rules, minimum instalments and heads of department only take known, active, reviewed departments', async () => {
    const s = await admin('SUPER_ADMIN');
    const fee = await prisma.fee.findFirstOrThrow({ where: { feeType: { code: 'DEPT' } } });
    const typo = await s.post(`/v1/admin/fees/${fee.id}/eligibility-rules`, { department: 'COMPUTING' }).expect(400);
    expect(typo.body.error).toMatchObject({ code: 'VALIDATION', message: 'Unknown department COMPUTING' });
    await s.post(`/v1/admin/fees/${fee.id}/rate-rules`, { department: 'CIVIL-ENG', amount: '1000' }).expect(400); // inactive
    const hod = await s.post('/v1/admin/users', { email: `hod-${randomUUID().slice(0, 6)}@unimak.test`, role: 'HEAD_OF_DEPARTMENT', departments: ['NURSING', 'COMPUTING'] }).expect(400);
    expect(hod.body.error.message).toBe('Unknown department COMPUTING');
  });

  it('a department in use cannot be deactivated', async () => {
    const s = await admin('SUPER_ADMIN');
    await s.post('/v1/admin/users', { email: `hod-${randomUUID().slice(0, 6)}@unimak.test`, role: 'HEAD_OF_DEPARTMENT', departments: ['CLIN-PSYCH'] }).expect(201);
    const res = await s.patch('/v1/admin/departments/CLIN-PSYCH', { active: false }).expect(409);
    expect(res.body.error.message).toMatch(/heads of department: hod-/);
    // the seeded DEPT fee's rules use COMPUTER-SCI
    expect((await s.patch('/v1/admin/departments/COMPUTER-SCI', { active: false }).expect(409)).body.error.message).toMatch(/rate rule/);
  });
});

describe('departments the portal sends', () => {
  it('applicants carry their department', async () => {
    await channel(http, 'get', '/v1/channel/payers/applicant/APP-2026-0002/obligations').expect(200);
    expect(await prisma.payer.findUniqueOrThrow({ where: { kind_ref: { kind: 'APPLICANT', ref: 'APP-2026-0002' } } })).toMatchObject({ department: 'NURSING' });
  });

  it('an unknown department never blocks a payer; it is added for review', async () => {
    const ob = await channel(http, 'get', '/v1/channel/payers/student/UNI-2026-0099/obligations').expect(200);
    expect(ob.body.obligations.map((o: { feeTypeCode: string }) => o.feeTypeCode)).toContain('MATRIC');
    const s = await admin('SUPER_ADMIN');
    const review = (await s.get('/v1/admin/departments?needsReview=true').expect(200)).body;
    expect(review).toEqual([expect.objectContaining({ code: 'ENGINEERING', name: 'ENGINEERING', facultyCode: null, needsReview: true, active: true })]);
    expect(await prisma.auditLog.count({ where: { action: 'department.auto_register', actorId: 'system' } })).toBe(1);

    // can't be used until reviewed
    const fee = await prisma.fee.findFirstOrThrow({ where: { feeType: { code: 'DEPT' } } });
    expect((await s.post(`/v1/admin/fees/${fee.id}/eligibility-rules`, { department: 'ENGINEERING' }).expect(400)).body.error.message).toMatch(/needs review/);
    await s.patch('/v1/admin/departments/ENGINEERING', { name: 'Engineering' }).expect(400); // still no faculty
    const reviewed = await s.patch('/v1/admin/departments/ENGINEERING', { name: 'Engineering', facultyCode: 'FAC-PURE-SCI' }).expect(200);
    expect(reviewed.body).toMatchObject({ name: 'Engineering', facultyCode: 'FAC-PURE-SCI', needsReview: false });
    await s.post(`/v1/admin/fees/${fee.id}/eligibility-rules`, { department: 'ENGINEERING' }).expect(201);
  });
});

describe('deans', () => {
  let csPayment: string;
  let nurPayment: string;

  beforeAll(async () => {
    csPayment = await pay('UNI-2026-0091', 'TUITION', '160000'); // COMPUTER-SCI
    nurPayment = await pay('UNI-2026-0092', 'TUITION', '210000'); // NURSING
  });

  it('need active faculties', async () => {
    const s = await admin('SUPER_ADMIN');
    await s.post('/v1/admin/users', { email: `dean-${randomUUID().slice(0, 6)}@unimak.test`, role: 'DEAN' }).expect(400);
    const unknown = await s.post('/v1/admin/users', { email: `dean-${randomUUID().slice(0, 6)}@unimak.test`, role: 'DEAN', faculties: ['FAC-NOPE'] }).expect(400);
    expect(unknown.body.error.message).toBe('Unknown faculty FAC-NOPE');
    await s.post('/v1/admin/users', { email: `dean-${randomUUID().slice(0, 6)}@unimak.test`, role: 'DEAN', faculties: ['FAC-ENG'] }).expect(400); // inactive
  });

  it('see every department of their faculties, as it is now', async () => {
    const s = await admin('SUPER_ADMIN');
    const email = `dean-${randomUUID().slice(0, 6)}@unimak.test`;
    const created = await s.post('/v1/admin/users', { email, role: 'DEAN', faculties: ['FAC-NURSING-AHS'], departments: ['LAW'] }).expect(201);
    expect(created.body).toMatchObject({ role: 'DEAN', faculties: ['FAC-NURSING-AHS'], departments: [] });
    const dean = as(adminToken({ sub: randomUUID(), email, aal: 'aal1' })); // no 2FA requirement for deans

    const me = (await dean.get('/v1/admin/me').expect(200)).body;
    expect(me).toMatchObject({ role: 'DEAN', departmentScoped: true, faculties: ['FAC-NURSING-AHS'], departments: ['CLIN-PSYCH', 'NURSING', 'PUBLIC-HEALTH'] });
    expect(me.permissions).toEqual(['fees.read', 'payers.read', 'payments.read', 'reports.read']);

    const ids = (await dean.get('/v1/admin/payments?limit=200').expect(200)).body.items.map((p: { id: string }) => p.id);
    expect(ids).toContain(nurPayment);
    expect(ids).not.toContain(csPayment);
    await dean.get(`/v1/admin/payments/${csPayment}`).expect(404);
    const report = (await dean.get('/v1/admin/reports/summary').expect(200)).body;
    expect(report).toMatchObject({ commission: null, payouts: null, filters: { departments: ['CLIN-PSYCH', 'NURSING', 'PUBLIC-HEALTH'] } });

    // moving a department out of the faculty applies at once (and back)
    await s.patch('/v1/admin/departments/NURSING', { facultyCode: 'FAC-PURE-SCI' }).expect(200);
    try {
      await dean.get(`/v1/admin/payments/${nurPayment}`).expect(404);
      expect((await dean.get('/v1/admin/me').expect(200)).body.departments).toEqual(['CLIN-PSYCH', 'PUBLIC-HEALTH']);
    } finally {
      await s.patch('/v1/admin/departments/NURSING', { facultyCode: 'FAC-NURSING-AHS' }).expect(200);
    }
    await dean.get(`/v1/admin/payments/${nurPayment}`).expect(200);

  });

  it('payments, exports and reports carry and filter by department and faculty', async () => {
    const s = await admin('SUPER_ADMIN');
    const nur = (await s.get('/v1/admin/payments?department=NURSING&limit=200').expect(200)).body.items;
    expect(nur.map((p: { id: string }) => p.id)).toContain(nurPayment);
    expect(nur.every((p: { payer: { department: string } }) => p.payer.department === 'NURSING')).toBe(true);
    expect(nur[0].payer).toMatchObject({ department: 'NURSING', departmentName: 'Nursing', facultyCode: 'FAC-NURSING-AHS', facultyName: 'Faculty of Nursing and Allied Health Sciences' });
    const fac = (await s.get('/v1/admin/payments?faculty=FAC-MASSCOM-CS&limit=200').expect(200)).body.items.map((p: { id: string }) => p.id);
    expect(fac).toContain(csPayment);
    expect(fac).not.toContain(nurPayment);

    const csv = (await s.get('/v1/admin/payments/export.csv?faculty=FAC-NURSING-AHS').expect(200)).text;
    const [header, ...lines] = csv.replace(/^﻿/, '').trim().split('\r\n');
    expect(header).toContain('department,department_name,faculty,faculty_name');
    expect(lines.find((l) => l.endsWith(nurPayment))).toContain(',NURSING,Nursing,FAC-NURSING-AHS,Faculty of Nursing and Allied Health Sciences,');

    const today = new Date().toISOString().slice(0, 10);
    const all = (await s.get(`/v1/admin/reports/summary?from=${today}&to=${today}`).expect(200)).body;
    const nursingFaculty = all.byFaculty.find((r: { facultyCode: string }) => r.facultyCode === 'FAC-NURSING-AHS');
    expect(nursingFaculty).toMatchObject({ facultyName: 'Faculty of Nursing and Allied Health Sciences' });
    expect(all.byDepartment.find((r: { department: string }) => r.department === 'NURSING')).toMatchObject({ departmentName: 'Nursing', facultyCode: 'FAC-NURSING-AHS' });
    const sum = (rows: { amount: string }[]) => rows.reduce((n, r) => n + BigInt(r.amount), 0n);
    expect(sum(all.byFaculty)).toBe(BigInt(all.collected.amount));
    expect(sum(all.byDepartment)).toBe(BigInt(all.collected.amount));

    const onlyNursing = (await s.get(`/v1/admin/reports/summary?from=${today}&to=${today}&faculty=FAC-NURSING-AHS`).expect(200)).body;
    expect(onlyNursing.collected.amount).toBe(nursingFaculty.amount);
    expect(onlyNursing.filters).toMatchObject({ faculty: 'FAC-NURSING-AHS', department: null });
    const dept = (await s.get(`/v1/admin/reports/summary?from=${today}&to=${today}&department=COMPUTER-SCI`).expect(200)).body;
    expect(dept.byDepartment.map((r: { department: string }) => r.department)).toEqual(['COMPUTER-SCI']);
  });

  it('keep their faculty from being deactivated', async () => {
    const s = await admin('SUPER_ADMIN');
    await s.post('/v1/admin/faculties', { code: 'FAC-TMP', name: 'Temporary' }).expect(201);
    await s.post('/v1/admin/users', { email: `dean-${randomUUID().slice(0, 6)}@unimak.test`, role: 'DEAN', faculties: ['FAC-TMP'] }).expect(201);
    const res = await s.patch('/v1/admin/faculties/FAC-TMP', { active: false }).expect(409);
    expect(res.body.error.message).toMatch(/still assigned to deans: dean-/);
  });
});
