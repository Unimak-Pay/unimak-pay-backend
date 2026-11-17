import { bpsOfHalfUp, formatSle, parseMinor } from './money';
import { maskName, maskPhone } from './mask';

describe('bpsOfHalfUp', () => {
  it('computes basis points of an amount', () => {
    expect(bpsOfHalfUp(100_000n, 250)).toBe(2_500n); // 2.5% of SLE 1,000
  });
  it('rounds half up at exactly .5 minor unit', () => {
    expect(bpsOfHalfUp(20n, 250)).toBe(1n); // 0.5 → 1
    expect(bpsOfHalfUp(19n, 250)).toBe(0n); // 0.475 → 0
    expect(bpsOfHalfUp(60n, 250)).toBe(2n); // 1.5 → 2
  });
  it('rejects negatives', () => {
    expect(() => bpsOfHalfUp(-1n, 250)).toThrow(RangeError);
  });
});

describe('formatSle', () => {
  it('formats minor units', () => {
    expect(formatSle(123_450n)).toBe('SLE 1,234.50');
    expect(formatSle(5n)).toBe('SLE 0.05');
    expect(formatSle(-50n)).toBe('-SLE 0.50');
  });
});

describe('parseMinor', () => {
  it('accepts digit strings and safe integers only', () => {
    expect(parseMinor('1500')).toBe(1500n);
    expect(parseMinor(1500)).toBe(1500n);
    expect(parseMinor(15.5)).toBeNull();
    expect(parseMinor('-1')).toBeNull();
    expect(parseMinor('1e3')).toBeNull();
  });
});

describe('masking', () => {
  it('masks names to initials', () => {
    expect(maskName('Aminata  Kamara')).toBe('A*** K***');
  });
  it('masks phones', () => {
    expect(maskPhone('+23276123456')).toBe('+232*****456');
  });
});
