import { parsePortalEvent } from './portal-event';

const student = {
  studentId: 'UNI-2026-0001', applicationRef: 'APP-2026-0001', fullName: 'Abdul Koroma', phone: '+23276200001',
  programCode: 'BSC-CS', department: 'COMPUTER-SCI', level: 1, finalYear: false, residency: 'LOCAL', intake: '2026-SEP',
  enrolmentStatus: 'ACTIVE', updatedAt: '2026-11-21T09:15:02.123Z',
};
const applicant = {
  applicationRef: 'APP-2026-0001', fullName: 'Aminata Kamara', phone: '+23276100001', programCode: 'BSC-CS',
  department: 'COMPUTER-SCI', intake: '2026-SEP', residency: 'LOCAL', status: 'APPLIED', updatedAt: '2026-11-21T09:15:02Z',
};
const ev = (type: string, data: unknown) => ({ type, occurredAt: '2026-11-21T09:15:02Z', data });

describe('parsePortalEvent', () => {
  it('maps a student to a payer snapshot', () => {
    const r = parsePortalEvent(ev('student.upserted', student));
    expect(r).toEqual({
      ok: true,
      event: {
        type: 'student.upserted', occurredAt: new Date('2026-11-21T09:15:02Z'), portalUpdatedAt: new Date('2026-11-21T09:15:02.123Z'),
        snapshot: {
          kind: 'STUDENT', ref: 'UNI-2026-0001', fullName: 'Abdul Koroma', phone: '+23276200001', programCode: 'BSC-CS',
          department: 'COMPUTER-SCI', level: 1, finalYear: false, residency: 'LOCAL', intake: '2026-SEP',
          applicantStatus: null, enrolmentStatus: 'ACTIVE', applicationRef: 'APP-2026-0001',
        },
      },
    });
  });

  it('maps an applicant (no level, no enrolment status)', () => {
    const r = parsePortalEvent(ev('applicant.upserted', applicant));
    expect(r.ok && r.event.snapshot).toMatchObject({ kind: 'APPLICANT', ref: 'APP-2026-0001', level: null, applicantStatus: 'APPLIED', enrolmentStatus: null });
    expect(parsePortalEvent(ev('applicant.upserted', { ...applicant, status: 'WITHDRAWN' })).ok).toBe(true);
  });

  it('accepts a student without applicationRef, and unknown department codes', () => {
    const { applicationRef: _, ...noApp } = student;
    expect(parsePortalEvent(ev('student.upserted', { ...noApp, department: 'NEW-DEPT' }))).toMatchObject({ ok: true, event: { snapshot: { applicationRef: null, department: 'NEW-DEPT' } } });
  });

  it('lists every problem and keeps the ref for the log', () => {
    const r = parsePortalEvent(ev('student.upserted', { ...student, level: 11, phone: '076200001', enrolmentStatus: 'ENROLLED', updatedAt: 'yesterday' }));
    expect(r).toEqual({
      ok: false, ref: 'UNI-2026-0001',
      error: 'phone must be in international format, e.g. +23276123456; updatedAt must be an ISO 8601 date-time; level must be a whole number from 1 to 10; enrolmentStatus must be one of ACTIVE, SUSPENDED, WITHDRAWN, GRADUATED',
    });
  });

  it('rejects unknown types and missing data', () => {
    expect(parsePortalEvent(ev('student.deleted', student))).toMatchObject({ ok: false, error: 'type must be one of applicant.upserted, student.upserted' });
    expect(parsePortalEvent(ev('student.upserted', null))).toMatchObject({ ok: false, error: 'data must be an object', ref: null });
    expect(parsePortalEvent({ type: 'student.upserted', data: student })).toMatchObject({ ok: false, error: 'occurredAt must be an ISO 8601 date-time' });
  });
});
