import { computePosition } from '../../ledger/domain/position';
import { assertCanInitiate } from './payment-policy';
import { canTransition } from './payment-status';

const now = new Date('2026-11-17T12:00:00Z');
const in10 = new Date('2026-11-17T12:10:00Z');
const APP = 15_000n;

describe('application fee: once paid, a second payment is refused', () => {
  const charged = [{ type: 'CHARGE' as const, amount: APP }];

  it('accepts the first full payment', () => {
    const position = computePosition(APP, charged, [], now);
    expect(() => assertCanInitiate({ feeTypeCode: 'APP', feeActive: true, position, minInstalment: APP, amount: APP })).not.toThrow();
  });

  it('refuses a second payment after settlement', () => {
    const position = computePosition(APP, [...charged, { type: 'PAYMENT', amount: -APP }], [], now);
    expect(() => assertCanInitiate({ feeTypeCode: 'APP', feeActive: true, position, minInstalment: 0n, amount: APP }))
      .toThrow(expect.objectContaining({ code: 'OBLIGATION_SETTLED', message: expect.stringMatching(/application fee has already been paid/) }));
  });

  it('refuses a second payment while the first is pending (hold covers balance)', () => {
    const position = computePosition(APP, charged, [{ amount: APP, status: 'PENDING', expiresAt: in10 }], now);
    expect(() => assertCanInitiate({ feeTypeCode: 'APP', feeActive: true, position, minInstalment: APP, amount: APP }))
      .toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
  });

  it('allows paying again after the first attempt expired', () => {
    const position = computePosition(APP, charged, [{ amount: APP, status: 'PENDING', expiresAt: now }], now);
    expect(() => assertCanInitiate({ feeTypeCode: 'APP', feeActive: true, position, minInstalment: APP, amount: APP })).not.toThrow();
  });

  it('still refuses once paid even if the fee was later closed', () => {
    const position = computePosition(APP, [...charged, { type: 'PAYMENT', amount: -APP }], [], now);
    expect(() => assertCanInitiate({ feeTypeCode: 'APP', feeActive: false, position, minInstalment: 0n, amount: 1n }))
      .toThrow(expect.objectContaining({ code: 'OBLIGATION_SETTLED' }));
  });
});

describe('instalment bounds: min ≤ amount ≤ payable', () => {
  const position = computePosition(300_000n, [{ type: 'CHARGE', amount: 300_000n }], [{ amount: 100_000n, status: 'PENDING', expiresAt: in10 }], now);
  const base = { feeTypeCode: 'TUITION', feeActive: true, position, minInstalment: 50_000n };
  it('rejects below minimum', () => expect(() => assertCanInitiate({ ...base, amount: 49_999n })).toThrow(expect.objectContaining({ code: 'AMOUNT_BELOW_MIN_INSTALMENT' })));
  it('rejects above payable (balance − holds)', () => expect(() => assertCanInitiate({ ...base, amount: 200_001n })).toThrow(expect.objectContaining({ code: 'AMOUNT_EXCEEDS_PAYABLE' })));
  it('accepts the bounds', () => {
    expect(() => assertCanInitiate({ ...base, amount: 50_000n })).not.toThrow();
    expect(() => assertCanInitiate({ ...base, amount: 200_000n })).not.toThrow();
  });
});

describe('payment status machine', () => {
  it('COMPLETED is terminal', () => {
    expect(canTransition('COMPLETED', 'FAILED')).toBe(false);
    expect(canTransition('COMPLETED', 'EXPIRED')).toBe(false);
  });
  it('late settlement: EXPIRED/FAILED can still complete, nothing else', () => {
    expect(canTransition('EXPIRED', 'COMPLETED')).toBe(true);
    expect(canTransition('FAILED', 'COMPLETED')).toBe(true);
    expect(canTransition('EXPIRED', 'PENDING')).toBe(false);
    expect(canTransition('FAILED', 'EXPIRED')).toBe(false);
  });
});
