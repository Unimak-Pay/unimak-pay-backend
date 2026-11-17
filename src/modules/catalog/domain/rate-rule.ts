import { DomainError } from '../../../shared/domain/errors';
import type { Minor } from '../../../shared/domain/money';
import {
  compatible,
  describeMatchers,
  type Matchers,
  matchesProfile,
  sameMatchers,
  specificity,
  union,
} from './matchers';
import type { PayerProfile } from './payer-profile';

export interface RateRule extends Matchers {
  id: string;
  amount: Minor;
}

/**
 * Most specific matching rule wins (specificity = number of constrained matchers).
 * Returns null when nothing matches. Throws on a tie at the top — that should be
 * impossible if every save went through `assertRateRulesUnambiguous`.
 */
export function resolveRate(rules: readonly RateRule[], profile: PayerProfile): RateRule | null {
  const matching = rules.filter((r) => matchesProfile(r, profile));
  if (matching.length === 0) return null;
  const best = Math.max(...matching.map(specificity));
  const top = matching.filter((r) => specificity(r) === best);
  if (top.length > 1) {
    throw new DomainError('AMBIGUOUS_RATE_RULE', 'More than one rate rule matches equally', {
      ruleIds: top.map((r) => r.id),
    });
  }
  return top[0] ?? null;
}

export interface RateRuleConflict {
  a: RateRule;
  b: RateRule;
  /** The rule that would resolve the tie, if it existed. */
  missingTieBreaker: Matchers;
}

/**
 * A rule set is ambiguous iff two rules of equal specificity can both match the
 * same payer and there is no rule covering exactly the union of their matchers
 * (which would be strictly more specific and win for every such payer).
 * Identical matcher sets are always a conflict.
 */
export function findRateRuleConflicts(rules: readonly RateRule[]): RateRuleConflict[] {
  const conflicts: RateRuleConflict[] = [];
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i]!;
      const b = rules[j]!;
      if (specificity(a) !== specificity(b) || !compatible(a, b)) continue;
      const u = union(a, b);
      const resolved = !sameMatchers(a, b) && rules.some((r) => sameMatchers(r, u));
      if (!resolved) conflicts.push({ a, b, missingTieBreaker: u });
    }
  }
  return conflicts;
}

/** Validates the set that would exist after saving `candidate`. */
export function assertRateRulesUnambiguous(
  existing: readonly RateRule[],
  candidate: RateRule,
): void {
  const next = [...existing.filter((r) => r.id !== candidate.id), candidate];
  const conflicts = findRateRuleConflicts(next).filter(
    (c) => c.a.id === candidate.id || c.b.id === candidate.id,
  );
  const first = conflicts[0];
  if (!first) return;
  const other = first.a.id === candidate.id ? first.b : first.a;
  throw new DomainError(
    'AMBIGUOUS_RATE_RULE',
    sameMatchers(first.a, first.b)
      ? `A rate rule with the same matchers already exists (${describeMatchers(other)})`
      : `Rule ties with [${describeMatchers(other)}]; add a rule for [${describeMatchers(first.missingTieBreaker)}] first`,
    { conflictingRuleId: other.id, missingTieBreaker: first.missingTieBreaker },
  );
}
