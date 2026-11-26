import type { PayerKind, PayerProfile, Residency } from '../../catalog/domain/payer-profile';

export interface PayerSnapshot {
  kind: PayerKind;
  /** applicationRef (applicants) or studentId (students) */
  ref: string;
  fullName: string;
  phone: string;
  /**
   * null = none / cleared. undefined (snapshots only) = not said: keep what we hold.
   * Events clear it with an explicit null; a portal lookup without one never does.
   */
  email?: string | null;
  programCode: string;
  department: string | null;
  level: number | null;
  finalYear: boolean | null;
  residency: Residency;
  intake: string;
  applicantStatus: string | null;
  /** students, when the portal says (events); null = not known, treated as active */
  enrolmentStatus: EnrolmentStatus | null;
  /** students: the application they came from */
  applicationRef: string | null;
}

export type EnrolmentStatus = 'ACTIVE' | 'SUSPENDED' | 'WITHDRAWN' | 'GRADUATED';
export const ENROLMENT_STATUSES: readonly EnrolmentStatus[] = ['ACTIVE', 'SUSPENDED', 'WITHDRAWN', 'GRADUATED'];

export interface Payer extends PayerSnapshot {
  id: string;
  /** when we last got this record from the portal (event or lookup) */
  snapshotAt: Date;
  /** the portal's updatedAt of the last event applied */
  portalUpdatedAt: Date | null;
}

/**
 * Only students the portal says aren't active get no new charges. What they already
 * owe stays payable (owner decision, 2026-11-21).
 */
export function canBeCharged(p: Pick<PayerSnapshot, 'kind' | 'enrolmentStatus'>): boolean {
  return p.kind !== 'STUDENT' || p.enrolmentStatus === null || p.enrolmentStatus === 'ACTIVE';
}

export function toProfile(p: PayerSnapshot): PayerProfile {
  return {
    kind: p.kind,
    programCode: p.programCode,
    department: p.department,
    level: p.level,
    residency: p.residency,
    intake: p.intake,
    finalYear: p.finalYear,
  };
}

/** "BSC-CS · Level 2" / "BSC-CS · Applicant 2026-SEP" */
export function programLine(p: PayerSnapshot): string {
  return p.kind === 'STUDENT'
    ? `${p.programCode} · Level ${p.level ?? '?'}`
    : `${p.programCode} · Applicant ${p.intake}`;
}
