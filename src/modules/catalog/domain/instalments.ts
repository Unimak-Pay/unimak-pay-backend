import { DomainError } from '../../../shared/domain/errors';
import { minBig, type Minor } from '../../../shared/domain/money';

export const INSTALMENTS_MANAGE = 'instalments.manage';

export interface InstalmentPolicy {
  allowInstalments: boolean;
  defaultMinInstalment: Minor | null;
  /** program-specific override, if any */
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

export function assertCanManageInstalments(permissions: readonly string[]): void {
  if (!permissions.includes(INSTALMENTS_MANAGE)) {
    throw new DomainError('FORBIDDEN', `Missing permission ${INSTALMENTS_MANAGE}`);
  }
}
