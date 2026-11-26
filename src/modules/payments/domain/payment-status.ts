import { DomainError } from '../../../shared/domain/errors';

/**
 * Lifecycle (docs/payment-lifecycle.md):
 * - INITIATED: inserted; a USSD payment code is being created at Monime (moments).
 * - PENDING: awaiting payment. Never expires; deleted after PENDING_PAYMENT_RETENTION_DAYS,
 *   or as soon as another payment for the same fee completes.
 * - PROCESSING: Monime's payment.processing_started. Holds the amount. Back to PENDING
 *   if nothing completes it within PROCESSING_TIMEOUT_HOURS (Monime sends no failure event).
 * - COMPLETED: payment.processing_completed only.
 * - FAILED: Monime rejected the payment code at creation. EXPIRED: older payments only.
 * FAILED/EXPIRED → PROCESSING/COMPLETED is a late settlement: Monime is the truth for money.
 */
export type PaymentStatus = 'INITIATED' | 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
export const PAYMENT_STATUSES: readonly PaymentStatus[] = ['INITIATED', 'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'EXPIRED'];

const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  INITIATED: ['PENDING', 'PROCESSING', 'FAILED', 'COMPLETED'],
  PENDING: ['PROCESSING', 'COMPLETED'],
  PROCESSING: ['COMPLETED', 'PENDING'],
  COMPLETED: [],
  FAILED: ['PROCESSING', 'COMPLETED'],
  EXPIRED: ['PROCESSING', 'COMPLETED'],
};

/** Not finished: can still be paid. */
export function isOpen(s: PaymentStatus): boolean {
  return s === 'INITIATED' || s === 'PENDING' || s === 'PROCESSING';
}

/** Awaiting payment: what the cleanup deletes (no ledger entry, receipt or money yet). */
export function isAwaitingPayment(s: PaymentStatus): boolean {
  return s === 'INITIATED' || s === 'PENDING';
}

export function isLateSettlement(from: PaymentStatus): boolean {
  return from === 'FAILED' || from === 'EXPIRED';
}

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw new DomainError('INVALID_STATE', `Payment cannot go from ${from} to ${to}`);
  }
}
