/**
 * Money is always a bigint of SLE minor units (1 SLE = 100 minor units).
 * No floats anywhere. These helpers are pure.
 */
export type Minor = bigint;

export const MINOR_PER_SLE = 100n;
const BPS_DENOMINATOR = 10_000n;

/** amount × bps / 10 000, rounded half-up. Amount and bps must be non-negative. */
export function bpsOfHalfUp(amount: Minor, bps: number | bigint): Minor {
  const b = BigInt(bps);
  if (amount < 0n || b < 0n) throw new RangeError('bpsOfHalfUp expects non-negative inputs');
  return (amount * b + BPS_DENOMINATOR / 2n) / BPS_DENOMINATOR;
}

export function minBig(a: Minor, b: Minor): Minor {
  return a < b ? a : b;
}

export function maxBig(a: Minor, b: Minor): Minor {
  return a > b ? a : b;
}

export function sumBig(values: Iterable<Minor>): Minor {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

/** "SLE 1,234.50" */
export function formatSle(amount: Minor): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const whole = (abs / MINOR_PER_SLE).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (abs % MINOR_PER_SLE).toString().padStart(2, '0');
  return `${neg ? '-' : ''}SLE ${whole}.${cents}`;
}

/** Parses a non-negative integer of minor units from a string or safe integer. */
export function parseMinor(value: unknown): Minor | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'string' && /^\d{1,18}$/.test(value)) return BigInt(value);
  return null;
}
