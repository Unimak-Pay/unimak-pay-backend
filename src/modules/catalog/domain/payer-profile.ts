export type PayerKind = 'APPLICANT' | 'STUDENT';
export type Residency = 'LOCAL' | 'INTERNATIONAL';

/** The attributes rules match against (snapshot of the portal record). */
export interface PayerProfile {
  kind: PayerKind;
  programCode: string;
  department: string | null;
  level: number | null;
  residency: Residency;
  intake: string;
  finalYear: boolean | null;
}
