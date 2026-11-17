import { maxBig, type Minor } from '../../../shared/domain/money';

export type LedgerEntryType = 'CHARGE' | 'PAYMENT' | 'ADJUSTMENT' | 'REFUND';

export interface LedgerEntryLike {
  type: LedgerEntryType;
  /** signed: CHARGE/REFUND > 0, PAYMENT < 0, ADJUSTMENT ± */
  amount: Minor;
}

export interface HoldLike {
  amount: Minor;
  status: 'INITIATED' | 'PENDING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
  expiresAt: Date;
}

export interface ObligationPosition {
  /** amount charged when the obligation was created */
  amount: Minor;
  /** net money received (payments − refunds) */
  paid: Minor;
  /** sum of all ledger entries: what is still owed */
  balance: Minor;
  /** in-flight payments that haven't expired */
  holds: Minor;
  /** balance − holds, never below 0 */
  payable: Minor;
}

export function isActiveHold(h: HoldLike, now: Date): boolean {
  return (h.status === 'INITIATED' || h.status === 'PENDING') && h.expiresAt > now;
}

export function computePosition(
  amount: Minor,
  entries: readonly LedgerEntryLike[],
  pending: readonly HoldLike[],
  now: Date,
): ObligationPosition {
  let balance = 0n;
  let paid = 0n;
  for (const e of entries) {
    balance += e.amount;
    if (e.type === 'PAYMENT') paid += -e.amount;
    if (e.type === 'REFUND') paid -= e.amount;
  }
  const holds = pending.filter((h) => isActiveHold(h, now)).reduce((s, h) => s + h.amount, 0n);
  return { amount, paid, balance, holds, payable: maxBig(balance - holds, 0n) };
}
