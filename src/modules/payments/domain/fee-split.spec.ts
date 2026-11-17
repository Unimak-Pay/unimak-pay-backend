import { splitFees } from './fee-split';

const USSD = { totalRateBps: 250, monimeRateBps: 100, monimeFlat: 0n };
const DOTS = { totalRateBps: 250, monimeRateBps: 0, monimeFlat: 50n };

describe('splitFees — USSD (Monime 1%, platform 1.5%)', () => {
  it('SLE 1,000.00', () => {
    expect(splitFees(100_000n, USSD)).toEqual({
      amount: 100_000n, total: 2_500n, monimeFee: 1_000n, platformFee: 1_500n, netAmount: 97_500n,
    });
  });

  it('computes the 2.5% total first, then platform = total − Monime (rounding lands on platform)', () => {
    // 2.5% of 1,234.57 = 30.86425 → 30.86 ; 1% = 12.3457 → 12.35 ; platform = 18.51
    const s = splitFees(123_457n, USSD);
    expect(s).toMatchObject({ total: 3_086n, monimeFee: 1_235n, platformFee: 1_851n, netAmount: 120_371n });
    expect(s.monimeFee + s.platformFee).toBe(s.total);
  });

  it('half-up rounding at exactly .5', () => {
    // 2.5% of 0.20 = 0.005 → 0.01 ; 1% = 0.002 → 0.00
    expect(splitFees(20n, USSD)).toMatchObject({ total: 1n, monimeFee: 0n, platformFee: 1n, netAmount: 19n });
  });
});

describe('splitFees — DOTS (Monime SLE 0.50 flat, platform 2.5% − 0.50)', () => {
  it('SLE 1,000.00', () => {
    expect(splitFees(100_000n, DOTS)).toEqual({
      amount: 100_000n, total: 2_500n, monimeFee: 50n, platformFee: 2_450n, netAmount: 97_500n,
    });
  });

  it('exactly SLE 20: total = 0.50 = Monime fee, platform 0', () => {
    expect(splitFees(2_000n, DOTS)).toMatchObject({ total: 50n, monimeFee: 50n, platformFee: 0n, netAmount: 1_950n });
  });

  it('under SLE 20: platform never below 0, UNIMAK absorbs the Monime fee', () => {
    expect(splitFees(1_000n, DOTS)).toMatchObject({ total: 25n, monimeFee: 50n, platformFee: 0n, netAmount: 950n });
  });

  it('just above SLE 20', () => {
    // 2.5% of 20.40 = 0.51 → platform 0.01
    expect(splitFees(2_040n, DOTS)).toMatchObject({ total: 51n, monimeFee: 50n, platformFee: 1n, netAmount: 1_989n });
  });

  it('rejects amounts smaller than the Monime fee', () => {
    expect(() => splitFees(40n, DOTS)).toThrow(/smaller than the transaction fee/);
  });
});

describe('invariant', () => {
  it('net + monime + platform = amount for many amounts on both channels', () => {
    for (const rates of [USSD, DOTS]) {
      for (let a = 50n; a < 300_000n; a += 977n) {
        const s = splitFees(a, rates);
        expect(s.netAmount + s.monimeFee + s.platformFee).toBe(a);
        expect(s.platformFee).toBeGreaterThanOrEqual(0n);
      }
    }
  });
});
