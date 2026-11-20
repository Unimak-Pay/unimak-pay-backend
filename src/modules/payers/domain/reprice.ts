import { DomainError } from '../../../shared/domain/errors';
import type { Minor } from '../../../shared/domain/money';
import { type EligibilityRule, isEligible } from '../../catalog/domain/eligibility';
import type { PayerProfile } from '../../catalog/domain/payer-profile';
import { type RateRule, resolveRate } from '../../catalog/domain/rate-rule';

export type RepriceSkipReason =
  | 'PAID'
  | 'HAS_PAYMENTS'
  | 'PAYMENT_IN_PROGRESS'
  | 'NOT_ELIGIBLE'
  | 'NO_RATE_RULE'
  | 'AMBIGUOUS_RATE_RULE';

export interface RepriceInput {
  status: 'OPEN' | 'PAID';
  amount: Minor;
  /** ledger entry types on the obligation */
  entryTypes: readonly string[];
  /** payments not yet final: their hold counts until expiresAt */
  openPayments: readonly { status: string; expiresAt: Date }[];
  profile: PayerProfile;
}

export type RepriceDecision =
  | { kind: 'CHANGE'; proposed: Minor; difference: Minor; rateRuleId: string }
  | { kind: 'UNCHANGED' }
  | { kind: 'SKIP'; reason: RepriceSkipReason };

/**
 * Whether an existing obligation should follow the fee's current rate rules.
 * Only untouched obligations move: OPEN, no payment or refund in the ledger, and no
 * payment in progress. Anything else is left for a person to decide. The obligation
 * is never cancelled here (a payer who is no longer eligible is reported, not removed).
 */
export function decideReprice(o: RepriceInput, rules: { rateRules: readonly RateRule[]; eligibilityRules: readonly EligibilityRule[] }, now: Date): RepriceDecision {
  if (o.status === 'PAID') return { kind: 'SKIP', reason: 'PAID' };
  if (o.entryTypes.some((t) => t === 'PAYMENT' || t === 'REFUND')) return { kind: 'SKIP', reason: 'HAS_PAYMENTS' };
  if (o.openPayments.some((p) => (p.status === 'INITIATED' || p.status === 'PENDING') && p.expiresAt > now)) {
    return { kind: 'SKIP', reason: 'PAYMENT_IN_PROGRESS' };
  }
  if (!isEligible(rules.eligibilityRules, o.profile)) return { kind: 'SKIP', reason: 'NOT_ELIGIBLE' };
  let rule: RateRule | null;
  try {
    rule = resolveRate(rules.rateRules, o.profile);
  } catch (err) {
    if (err instanceof DomainError && err.code === 'AMBIGUOUS_RATE_RULE') return { kind: 'SKIP', reason: 'AMBIGUOUS_RATE_RULE' };
    throw err;
  }
  if (!rule) return { kind: 'SKIP', reason: 'NO_RATE_RULE' };
  if (rule.amount === o.amount) return { kind: 'UNCHANGED' };
  return { kind: 'CHANGE', proposed: rule.amount, difference: rule.amount - o.amount, rateRuleId: rule.id };
}
