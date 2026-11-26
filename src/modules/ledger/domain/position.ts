import { maxBig, type Minor } from '../../../shared/domain/money';

export type LedgerEntryType = 'CHARGE' | 'PAYMENT' | 'ADJUSTMENT' | 'REFUND';

export interface LedgerEntryLike {
  type: LedgerEntryType;
  /** signed: CHARGE/REFUND > 0, PAYMENT < 0, ADJUSTMENT ± */
  amount: Minor;
}

export interface HoldLike {
  amount: Minor;
  status: 'INITIATED' | 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
  /** when Monime said processing started */
  processingAt: Date | null;
}

/**
 * A PROCESSING payment stops holding after this long without completing; the cleanup
 * then puts it back to PENDING (Monime sends no failure event).
 */
export const PROCESSING_TIMEOUT_MS = 24 * 60 * 60_000;

export interface ObligationPosition {
  /** amount charged when the obligation was created */
  amount: Minor;
  /** net money received (payments − refunds) */
  paid: Minor;
  /** sum of all ledger entries: what is still owed */
  balance: Minor;
  /** payments Monime is processing (awaiting-payment ones hold nothing) */
  holds: Minor;
  /** balance − holds, never below 0 */
  payable: Minor;
}

/**
 * Only money Monime is processing holds the amount. A payment that is merely awaiting
 * payment (PENDING) holds nothing, so an abandoned one never blocks a fee; an
 * overpayment from two completing goes to reconciliation for a refund.
 */
export function isActiveHold(h: HoldLike, now: Date, timeoutMs = PROCESSING_TIMEOUT_MS): boolean {
  return h.status === 'PROCESSING' && !!h.processingAt && now.getTime() - h.processingAt.getTime() < timeoutMs;
}

export function computePosition(
  amount: Minor,
  entries: readonly LedgerEntryLike[],
  pending: readonly HoldLike[],
  now: Date,
  processingTimeoutMs = PROCESSING_TIMEOUT_MS,
): ObligationPosition {
  let balance = 0n;
  let paid = 0n;
  for (const e of entries) {
    balance += e.amount;
    if (e.type === 'PAYMENT') paid += -e.amount;
    if (e.type === 'REFUND') paid -= e.amount;
  }
  const holds = pending.filter((h) => isActiveHold(h, now, processingTimeoutMs)).reduce((s, h) => s + h.amount, 0n);
  return { amount, paid, balance, holds, payable: maxBig(balance - holds, 0n) };
}
