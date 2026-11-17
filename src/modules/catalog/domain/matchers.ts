import type { PayerProfile, Residency } from './payer-profile';

/** Optional matchers shared by rate and eligibility rules. null = wildcard. */
export interface Matchers {
  programCode: string | null;
  department: string | null;
  level: number | null;
  residency: Residency | null;
  intake: string | null;
}

export const MATCHER_KEYS = ['programCode', 'department', 'level', 'residency', 'intake'] as const;
export type MatcherKey = (typeof MATCHER_KEYS)[number];

export function matchesProfile(m: Matchers, p: PayerProfile): boolean {
  return MATCHER_KEYS.every((k) => m[k] === null || m[k] === p[k]);
}

export function specificity(m: Matchers): number {
  return MATCHER_KEYS.filter((k) => m[k] !== null).length;
}

/** Two matcher sets can both match some payer iff they agree on every key both constrain. */
export function compatible(a: Matchers, b: Matchers): boolean {
  return MATCHER_KEYS.every((k) => a[k] === null || b[k] === null || a[k] === b[k]);
}

export function sameMatchers(a: Matchers, b: Matchers): boolean {
  return MATCHER_KEYS.every((k) => a[k] === b[k]);
}

/** The matcher set constraining every key either side constrains (assumes compatible). */
export function union(a: Matchers, b: Matchers): Matchers {
  return {
    programCode: a.programCode ?? b.programCode,
    department: a.department ?? b.department,
    level: a.level ?? b.level,
    residency: a.residency ?? b.residency,
    intake: a.intake ?? b.intake,
  };
}

export function describeMatchers(m: Matchers): string {
  const parts = MATCHER_KEYS.filter((k) => m[k] !== null).map((k) => `${k}=${String(m[k])}`);
  return parts.length ? parts.join(', ') : '(any)';
}
