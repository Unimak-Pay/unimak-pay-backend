import type { Minor } from '../../../shared/domain/money';

/**
 * Where a payer stands on what they've been billed (docs/analytics.md).
 * - NOT_BILLED: no obligations in the selection
 * - PAID: nothing outstanding
 * - PART_PAID: something collected, something outstanding
 * - UNPAID: nothing collected, something outstanding
 * Overdue is separate: outstanding on a fee whose due date has passed.
 */
export const STANDINGS = ['NOT_BILLED', 'PAID', 'PART_PAID', 'UNPAID'] as const;
export type Standing = (typeof STANDINGS)[number];

/** List filter: a standing, or OVERDUE (part-paid or unpaid past a due date). */
export const STANDING_FILTERS = [...STANDINGS, 'OVERDUE'] as const;
export type StandingFilter = (typeof STANDING_FILTERS)[number];

export interface Balances {
  obligations: number;
  /** CHARGE + ADJUSTMENT */
  billed: Minor;
  /** -(PAYMENT + REFUND) */
  collected: Minor;
  /** sum of each obligation's positive balance (an overpayment never offsets another fee) */
  outstanding: Minor;
}

export function standing(b: Balances): Standing {
  if (b.obligations === 0) return 'NOT_BILLED';
  if (b.outstanding <= 0n) return 'PAID';
  return b.collected > 0n ? 'PART_PAID' : 'UNPAID';
}

/** collected ÷ billed, 0–1 to 3 decimals; null when nothing is billed. */
export function collectionRate(billed: Minor, collected: Minor): number | null {
  if (billed <= 0n) return null;
  const permille = (collected * 1000n) / billed;
  return Number(permille < 0n ? 0n : permille > 1000n ? 1000n : permille) / 1000;
}

export interface CellTotals {
  students: number;
  billed: Minor;
  collected: Minor;
  outstanding: Minor;
  paid: number;
  partPaid: number;
  unpaid: number;
  overdue: number;
  overdueAmount: Minor;
}

export const EMPTY_TOTALS: CellTotals = { students: 0, billed: 0n, collected: 0n, outstanding: 0n, paid: 0, partPaid: 0, unpaid: 0, overdue: 0, overdueAmount: 0n };

/** Adds up grid cells (each payer is in exactly one cell, so the sums are exact). */
export function sumTotals(cells: readonly CellTotals[]): CellTotals & { collectionRate: number | null } {
  const t = cells.reduce<CellTotals>(
    (a, c) => ({
      students: a.students + c.students,
      billed: a.billed + c.billed,
      collected: a.collected + c.collected,
      outstanding: a.outstanding + c.outstanding,
      paid: a.paid + c.paid,
      partPaid: a.partPaid + c.partPaid,
      unpaid: a.unpaid + c.unpaid,
      overdue: a.overdue + c.overdue,
      overdueAmount: a.overdueAmount + c.overdueAmount,
    }),
    EMPTY_TOTALS,
  );
  return { ...t, collectionRate: collectionRate(t.billed, t.collected) };
}
