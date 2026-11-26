import { ENROLMENT_STATUSES, type EnrolmentStatus, type PayerSnapshot } from './payer';

/** docs/portal-events.md A3–A4 */
export const PORTAL_EVENT_TYPES = ['applicant.upserted', 'student.upserted'] as const;
export type PortalEventType = (typeof PORTAL_EVENT_TYPES)[number];
export const PORTAL_EVENT_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
export const MAX_EVENTS_PER_BATCH = 500;
export const APPLICANT_STATUSES = ['APPLIED', 'ADMITTED', 'REJECTED', 'WITHDRAWN'] as const;

const REF = /^[A-Za-z0-9_-]{1,64}$/;
const PHONE = /^\+\d{8,15}$/;
/** Deliberately loose: one @, no spaces, a dot in the domain. */
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Same rule as department codes (ACADEMIC_CODE); unknown codes are accepted and flagged for review. */
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const PROGRAM = /^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,39}$/;
const INTAKE = /^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,19}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

export interface ParsedPortalEvent {
  type: PortalEventType;
  occurredAt: Date;
  snapshot: PayerSnapshot;
  portalUpdatedAt: Date;
}

export type ParseResult = { ok: true; event: ParsedPortalEvent } | { ok: false; error: string; ref: string | null };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The record's id, for logging even when the rest is invalid. */
export function refOf(type: unknown, data: unknown): string | null {
  if (!isObj(data)) return null;
  const v = type === 'applicant.upserted' ? data['applicationRef'] : data['studentId'];
  return typeof v === 'string' ? v.slice(0, 64) : null;
}

/** Validates one event (envelope minus id) into a payer snapshot. Never throws. */
export function parsePortalEvent(e: Obj): ParseResult {
  const errors: string[] = [];
  const type = e['type'];
  const data = e['data'];
  const ref = refOf(type, data);
  const fail = (error: string): ParseResult => ({ ok: false, error, ref });

  if (type !== 'applicant.upserted' && type !== 'student.upserted') return fail(`type must be one of ${PORTAL_EVENT_TYPES.join(', ')}`);
  const occurredAt = date(e['occurredAt']);
  if (!occurredAt) errors.push('occurredAt must be an ISO 8601 date-time');
  if (!isObj(data)) return fail('data must be an object');

  const str = (k: string, re: RegExp, what: string): string => {
    const v = data[k];
    if (typeof v !== 'string' || !re.test(v)) errors.push(`${k} ${what}`);
    return typeof v === 'string' ? v : '';
  };
  const fullName = typeof data['fullName'] === 'string' ? data['fullName'].trim() : '';
  if (!fullName || fullName.length > 200) errors.push('fullName must be 1-200 characters');
  const phone = str('phone', PHONE, 'must be in international format, e.g. +23276123456');
  // optional: absent = keep what we hold; null = none
  const rawEmail = data['email'];
  let email: string | null | undefined;
  if (rawEmail === undefined) email = undefined;
  else if (rawEmail === null) email = null;
  else if (typeof rawEmail === 'string' && rawEmail.trim().length <= 254 && EMAIL.test(rawEmail.trim())) email = rawEmail.trim();
  else errors.push('email must be null or an email address (at most 254 characters)');
  const programCode = str('programCode', PROGRAM, 'must be 1-40 letters, digits or _ . / -');
  const department = str('department', CODE, 'must be 1-40 letters, digits or _ . - (starting with a letter or digit)');
  const intake = str('intake', INTAKE, 'must be 1-20 letters, digits or _ . / -');
  const residency = data['residency'];
  if (residency !== 'LOCAL' && residency !== 'INTERNATIONAL') errors.push('residency must be LOCAL or INTERNATIONAL');
  const portalUpdatedAt = date(data['updatedAt']);
  if (!portalUpdatedAt) errors.push('updatedAt must be an ISO 8601 date-time');

  let snapshot: PayerSnapshot;
  if (type === 'applicant.upserted') {
    const applicationRef = str('applicationRef', REF, 'must be 1-64 letters, digits, _ or -');
    const status = data['status'];
    if (!APPLICANT_STATUSES.includes(status as (typeof APPLICANT_STATUSES)[number])) errors.push(`status must be one of ${APPLICANT_STATUSES.join(', ')}`);
    snapshot = {
      kind: 'APPLICANT', ref: applicationRef, fullName, phone, email, programCode, department, level: null, finalYear: null,
      residency: residency as PayerSnapshot['residency'], intake, applicantStatus: status as string, enrolmentStatus: null, applicationRef: null,
    };
  } else {
    const studentId = str('studentId', REF, 'must be 1-64 letters, digits, _ or -');
    const level = data['level'];
    if (!Number.isInteger(level) || (level as number) < 1 || (level as number) > 10) errors.push('level must be a whole number from 1 to 10');
    const finalYear = data['finalYear'];
    if (typeof finalYear !== 'boolean') errors.push('finalYear must be true or false');
    const enrolmentStatus = data['enrolmentStatus'];
    if (!ENROLMENT_STATUSES.includes(enrolmentStatus as EnrolmentStatus)) errors.push(`enrolmentStatus must be one of ${ENROLMENT_STATUSES.join(', ')}`);
    const appRef = data['applicationRef'];
    if (appRef !== undefined && appRef !== null && (typeof appRef !== 'string' || !REF.test(appRef))) errors.push('applicationRef must be null or 1-64 letters, digits, _ or -');
    snapshot = {
      kind: 'STUDENT', ref: studentId, fullName, phone, email, programCode, department, level: level as number, finalYear: finalYear as boolean,
      residency: residency as PayerSnapshot['residency'], intake, applicantStatus: null,
      enrolmentStatus: enrolmentStatus as EnrolmentStatus, applicationRef: (appRef as string | null | undefined) ?? null,
    };
  }
  if (errors.length) return fail(errors.join('; '));
  return { ok: true, event: { type, occurredAt: occurredAt!, snapshot, portalUpdatedAt: portalUpdatedAt! } };
}

function date(v: unknown): Date | null {
  if (typeof v !== 'string' || !ISO.test(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
