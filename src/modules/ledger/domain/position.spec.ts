import { computePosition, type HoldLike } from './position';

const now = new Date('2026-11-17T12:00:00Z');
const later = new Date('2026-11-17T12:10:00Z');
const earlier = new Date('2026-11-17T11:50:00Z');
const hold = (amount: bigint, status: HoldLike['status'], expiresAt = later): HoldLike => ({ amount, status, expiresAt });

describe('computePosition (holds / payable)', () => {
  const charge = { type: 'CHARGE' as const, amount: 300_000n };

  it('fresh obligation: payable = balance = amount', () => {
    expect(computePosition(300_000n, [charge], [], now)).toEqual({
      amount: 300_000n, paid: 0n, balance: 300_000n, holds: 0n, payable: 300_000n,
    });
  });

  it('payments reduce balance and count as paid', () => {
    const p = computePosition(300_000n, [charge, { type: 'PAYMENT', amount: -100_000n }], [], now);
    expect(p).toMatchObject({ paid: 100_000n, balance: 200_000n, payable: 200_000n });
  });

  it('pending and initiated payments are holds', () => {
    const p = computePosition(300_000n, [charge], [hold(50_000n, 'PENDING'), hold(25_000n, 'INITIATED')], now);
    expect(p).toMatchObject({ balance: 300_000n, holds: 75_000n, payable: 225_000n });
  });

  it('expired, failed and completed payments are not holds', () => {
    const p = computePosition(300_000n, [charge], [
      hold(50_000n, 'PENDING', earlier),
      hold(50_000n, 'FAILED'),
      hold(50_000n, 'EXPIRED'),
      hold(50_000n, 'COMPLETED'),
    ], now);
    expect(p.holds).toBe(0n);
  });

  it('payable never goes below zero', () => {
    const p = computePosition(100n, [{ type: 'CHARGE', amount: 100n }], [hold(100n, 'PENDING'), hold(100n, 'PENDING')], now);
    expect(p.payable).toBe(0n);
  });

  it('refunds and adjustments flow into balance', () => {
    const p = computePosition(300_000n, [
      charge,
      { type: 'PAYMENT', amount: -300_000n },
      { type: 'REFUND', amount: 50_000n },
      { type: 'ADJUSTMENT', amount: -10_000n },
    ], [], now);
    expect(p).toMatchObject({ paid: 250_000n, balance: 40_000n, payable: 40_000n });
  });
});
