import { formatReceiptNumber, generateVerifyCode, isVerifyCodeShape } from './receipt';

describe('receipts', () => {
  it('formats UNIMAK-YYYY-NNNNNN', () => {
    expect(formatReceiptNumber(2026, 42)).toBe('UNIMAK-2026-000042');
    expect(() => formatReceiptNumber(2026, 1_000_000)).toThrow(RangeError);
  });
  it('generates readable verify codes', () => {
    const c = generateVerifyCode();
    expect(c).toHaveLength(10);
    expect(isVerifyCodeShape(c)).toBe(true);
    expect(isVerifyCodeShape('ABC0OI1L00')).toBe(false);
  });
});
