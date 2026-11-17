import { DomainError } from '../../../shared/domain/errors';
import { formatSle, type Minor } from '../../../shared/domain/money';

export const PAYOUTS_MANAGE = 'payouts.manage';

export function assertCanManagePayouts(permissions: readonly string[]): void {
  if (!permissions.includes(PAYOUTS_MANAGE)) {
    throw new DomainError('FORBIDDEN', `Missing permission ${PAYOUTS_MANAGE}`);
  }
}

/**
 * Monime's available balance already excludes payouts it has accepted; our own
 * REQUESTED payouts (recorded, not yet accepted) must be reserved on top.
 */
export function assertPayoutAffordable(input: { amount: Minor; available: Minor; reservedLocally: Minor }): void {
  if (input.amount <= 0n) throw new DomainError('VALIDATION', 'Payout amount must be positive');
  const spendable = input.available - input.reservedLocally;
  if (input.amount > spendable) {
    throw new DomainError('AMOUNT_EXCEEDS_PAYABLE', `Payout exceeds the available ${formatSle(spendable < 0n ? 0n : spendable)}`, {
      available: input.available.toString(),
      reserved: input.reservedLocally.toString(),
    });
  }
}

export type LocalPayoutStatus = 'REQUESTED' | 'SUBMITTED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export function payoutStatusFromMonime(s: 'pending' | 'processing' | 'completed' | 'failed'): LocalPayoutStatus {
  return { pending: 'SUBMITTED', processing: 'PROCESSING', completed: 'COMPLETED', failed: 'FAILED' }[s] as LocalPayoutStatus;
}

/** Final states never move; completed/failed from Monime always win over in-flight ones. */
export function canMovePayout(from: LocalPayoutStatus, to: LocalPayoutStatus): boolean {
  if (from === 'COMPLETED' || from === 'FAILED') return false;
  const rank: Record<LocalPayoutStatus, number> = { REQUESTED: 0, SUBMITTED: 1, PROCESSING: 2, COMPLETED: 3, FAILED: 3 };
  return rank[to] > rank[from];
}
