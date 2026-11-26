import { academicYearOf, paymentMethodLabel, shownInHistory } from './history';

describe('payment method', () => {
  it('maps Monime channel types only', () => {
    expect(paymentMethodLabel('momo')).toBe('Mobile money');
    expect(paymentMethodLabel('card')).toBe('Card');
    expect(paymentMethodLabel('bank')).toBe('Bank');
    expect(paymentMethodLabel('wallet')).toBe('Wallet');
    expect(paymentMethodLabel('m17')).toBeNull();
    expect(paymentMethodLabel(null)).toBeNull();
  });
});

describe('academic year', () => {
  it('is the latest YYYY/YY period of the obligations', () => {
    expect(academicYearOf(['2025/26', '2026/27', '2026-SEP'])).toBe('2026/27');
  });
  it('falls back to the latest period, or null', () => {
    expect(academicYearOf(['2026-SEP', '2025-SEP'])).toBe('2026-SEP');
    expect(academicYearOf([])).toBeNull();
  });
});

describe('what history shows', () => {
  const now = new Date('2026-11-26T12:00:00Z');
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
  it('completed always, open while open, failed/expired for 30 days', () => {
    expect(shownInHistory({ status: 'COMPLETED', expiresAt: days(400), createdAt: days(400) }, now)).toBe(true);
    expect(shownInHistory({ status: 'PENDING', expiresAt: new Date(now.getTime() + 60_000), createdAt: days(0) }, now)).toBe(true);
    expect(shownInHistory({ status: 'FAILED', expiresAt: days(29), createdAt: days(29) }, now)).toBe(true);
    expect(shownInHistory({ status: 'EXPIRED', expiresAt: days(31), createdAt: days(31) }, now)).toBe(false);
    expect(shownInHistory({ status: 'PENDING', expiresAt: days(40), createdAt: days(40) }, now)).toBe(false);
  });
});
