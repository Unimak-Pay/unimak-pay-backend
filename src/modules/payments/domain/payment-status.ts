import { DomainError } from '../../../shared/domain/errors';

export type PaymentStatus = 'INITIATED' | 'PENDING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';

/**
 * FAILED/EXPIRED → COMPLETED is a *late settlement*: Monime says the money moved
 * after we gave up locally. Monime is the truth for money, so we accept it.
 */
const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  INITIATED: ['PENDING', 'FAILED', 'EXPIRED', 'COMPLETED'],
  PENDING: ['COMPLETED', 'FAILED', 'EXPIRED'],
  COMPLETED: [],
  FAILED: ['COMPLETED'],
  EXPIRED: ['COMPLETED'],
};

export function isOpen(s: PaymentStatus): boolean {
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
