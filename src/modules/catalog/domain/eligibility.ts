import { type Matchers, matchesProfile } from './matchers';
import type { PayerProfile } from './payer-profile';

export interface EligibilityRule extends Matchers {
  finalYear: boolean | null;
}

/**
 * A payer owes a fee if any eligibility rule matches. A fee with no rules
 * applies to every payer of its payerKind.
 */
export function isEligible(rules: readonly EligibilityRule[], profile: PayerProfile): boolean {
  if (rules.length === 0) return true;
  return rules.some(
    (r) => matchesProfile(r, profile) && (r.finalYear === null || r.finalYear === profile.finalYear),
  );
}
