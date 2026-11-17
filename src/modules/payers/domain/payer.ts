import type { PayerKind, PayerProfile, Residency } from '../../catalog/domain/payer-profile';

export interface PayerSnapshot {
  kind: PayerKind;
  /** applicationRef (applicants) or studentId (students) */
  ref: string;
  fullName: string;
  phone: string;
  programCode: string;
  department: string | null;
  level: number | null;
  finalYear: boolean | null;
  residency: Residency;
  intake: string;
  applicantStatus: string | null;
}

export interface Payer extends PayerSnapshot {
  id: string;
  snapshotAt: Date;
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
