import { DomainError } from '../../../shared/domain/errors';
import { minBig, type Minor } from '../../../shared/domain/money';

export const INSTALMENTS_MANAGE = 'instalments.manage';

export interface InstalmentPolicy {
  allowInstalments: boolean;
  defaultMinInstalment: Minor | null;
  /** department (and level) override, if any — see pickInstalmentRule */
  ruleMinInstalment: Minor | null;
}

/**
 * Minimum acceptable payment given what's payable now.
 * - no instalments → the full payable amount
 * - otherwise rule override → fee default → full payable
 * Always capped at payable so a small remaining balance can still be cleared.
 */
export function minInstalment(policy: InstalmentPolicy, payable: Minor): Minor {
  if (payable <= 0n) return 0n;
  if (!policy.allowInstalments) return payable;
  const min = policy.ruleMinInstalment ?? policy.defaultMinInstalment ?? payable;
  return minBig(min, payable);
}

export interface InstalmentRuleLike {
  department: string;
  /** null = every level of the department */
  level: number | null;
  minInstalment: Minor;
}

/**
 * The rule for a payer: their department at their level, else the department's
 * all-levels rule. Applicants (no level) only get the all-levels rule.
 */
export function pickInstalmentRule<R extends InstalmentRuleLike>(rules: readonly R[], department: string | null, level: number | null): R | null {
  if (!department) return null;
  const ofDept = rules.filter((r) => r.department === department);
  return (level !== null ? ofDept.find((r) => r.level === level) : undefined) ?? ofDept.find((r) => r.level === null) ?? null;
}

export function assertCanManageInstalments(permissions: readonly string[]): void {
  if (!permissions.includes(INSTALMENTS_MANAGE)) {
    throw new DomainError('FORBIDDEN', `Missing permission ${INSTALMENTS_MANAGE}`);
  }
}
