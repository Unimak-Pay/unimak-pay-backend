import { isEligible } from '../../catalog/domain/eligibility';
import type { FeeWithRules } from '../../catalog/domain/fee';
import type { PayerProfile } from '../../catalog/domain/payer-profile';
import { resolveRate } from '../../catalog/domain/rate-rule';
import { DomainError } from '../../../shared/domain/errors';
import type { Minor } from '../../../shared/domain/money';

export interface ExistingObligationRef {
  feeId: string;
  feeTypeId: string;
}

export interface PlannedObligation {
  feeId: string;
  amount: Minor;
  rateRuleId: string;
}

export interface SkippedFee {
  feeId: string;
  reason: 'NO_RATE_RULE' | 'AMBIGUOUS_RATE_RULE';
}

/**
 * Decides which obligations a payer is missing.
 * - only ACTIVE fees of the payer's kind that the payer is eligible for
 * - one obligation per payer × fee
 * - ONCE fee types (e.g. APP) at most once per payer across all periods, so an
 *   application ref pays the application fee exactly once whatever happens
 * - amount = best rate rule now; a fee with no matching rule is skipped
 */
export function planObligations(
  profile: PayerProfile,
  fees: readonly FeeWithRules[],
  existing: readonly ExistingObligationRef[],
): { create: PlannedObligation[]; skipped: SkippedFee[] } {
  const haveFee = new Set(existing.map((e) => e.feeId));
  const haveType = new Set(existing.map((e) => e.feeTypeId));
  const create: PlannedObligation[] = [];
  const skipped: SkippedFee[] = [];

  for (const fee of fees) {
    if (fee.status !== 'ACTIVE' || fee.feeType.payerKind !== profile.kind) continue;
    if (haveFee.has(fee.id)) continue;
    if (fee.feeType.recurrence === 'ONCE' && haveType.has(fee.feeType.id)) continue;
    if (!isEligible(fee.eligibilityRules, profile)) continue;

    let rule;
    try {
      rule = resolveRate(fee.rateRules, profile);
    } catch (err) {
      if (err instanceof DomainError && err.code === 'AMBIGUOUS_RATE_RULE') {
        skipped.push({ feeId: fee.id, reason: 'AMBIGUOUS_RATE_RULE' });
        continue;
      }
      throw err;
    }
    if (!rule) {
      skipped.push({ feeId: fee.id, reason: 'NO_RATE_RULE' });
      continue;
    }
    create.push({ feeId: fee.id, amount: rule.amount, rateRuleId: rule.id });
    haveType.add(fee.feeType.id); // two ONCE fees of the same type in one pass → first wins
  }
  return { create, skipped };
}
