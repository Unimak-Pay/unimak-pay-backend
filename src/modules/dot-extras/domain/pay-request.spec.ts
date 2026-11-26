import { cleanText, firstName, isPayRequestCode, newPayRequestCode, payRequestExpiry, payRequestShareUrl, payRequestStatus } from './pay-request';

const at = (s: string) => new Date(s);

describe('pay request expiry', () => {
  const created = at('2026-11-12T10:24:00Z');
  it('30 days, end of day', () => {
    expect(payRequestExpiry(created, null).toISOString()).toBe('2026-12-12T23:59:59.000Z');
  });
  it('the due date if sooner', () => {
    expect(payRequestExpiry(created, at('2026-11-30T00:00:00Z')).toISOString()).toBe('2026-11-30T23:59:59.000Z');
  });
  it('never less than 3 days', () => {
    expect(payRequestExpiry(created, at('2026-11-13T00:00:00Z')).toISOString()).toBe('2026-11-15T23:59:59.000Z');
    expect(payRequestExpiry(created, at('2026-10-01T00:00:00Z')).toISOString()).toBe('2026-11-15T23:59:59.000Z');
  });
});

describe('pay request status', () => {
  const base = { cancelledAt: null, expiresAt: at('2026-12-12T23:59:59Z'), amount: 1000n, paid: 0n, obligationPaid: false };
  const now = at('2026-11-20T00:00:00Z');
  it('OPEN, PARTLY_PAID, PAID by what its payments added up to', () => {
    expect(payRequestStatus(base, now)).toBe('OPEN');
    expect(payRequestStatus({ ...base, paid: 400n }, now)).toBe('PARTLY_PAID');
    expect(payRequestStatus({ ...base, paid: 1000n }, now)).toBe('PAID');
  });
  it('"whatever you can" is PAID once the fee is paid off with its help', () => {
    expect(payRequestStatus({ ...base, amount: null, paid: 500n }, now)).toBe('PARTLY_PAID');
    expect(payRequestStatus({ ...base, amount: null, paid: 500n, obligationPaid: true }, now)).toBe('PAID');
  });
  it('a fee paid off elsewhere closes an unpaid request as EXPIRED', () => {
    expect(payRequestStatus({ ...base, obligationPaid: true }, now)).toBe('EXPIRED');
  });
  it('EXPIRED after expiresAt unless already PAID; CANCELLED wins', () => {
    const later = at('2026-12-13T00:00:00Z');
    expect(payRequestStatus({ ...base, paid: 400n }, later)).toBe('EXPIRED');
    expect(payRequestStatus({ ...base, paid: 1000n }, later)).toBe('PAID');
    expect(payRequestStatus({ ...base, cancelledAt: now, paid: 1000n }, now)).toBe('CANCELLED');
  });
});

describe('share URL', () => {
  it('has exactly request, kind, ref, fee and amount', () => {
    const url = new URL(payRequestShareUrl('https://dashit.to/d/abc/', { code: 'K7PQ2XA', kind: 'student', ref: 'UNI-2026-0001', obligationId: 'b2e3', amount: 149000n }));
    expect(url.origin + url.pathname).toBe('https://dashit.to/d/abc/sponsor');
    expect([...url.searchParams.keys()]).toEqual(['request', 'kind', 'ref', 'fee', 'amount']);
    expect(url.searchParams.get('amount')).toBe('149000');
  });
  it('sends an empty amount for "whatever you can"', () => {
    expect(payRequestShareUrl('https://x/d/a', { code: 'K7PQ2XA', kind: 'student', ref: 'R', obligationId: 'o', amount: null })).toMatch(/&amount=$/);
  });
});

describe('helpers', () => {
  it('codes are 7 readable characters', () => {
    const c = newPayRequestCode();
    expect(isPayRequestCode(c)).toBe(true);
    expect(isPayRequestCode('K7PQ2X0')).toBe(false);
    expect(isPayRequestCode('K7PQ2XAA')).toBe(false);
  });
  it('cleans text and takes the first name', () => {
    expect(cleanText('  hi\u0007 there  ')).toBe('hi there');
    expect(cleanText('   ')).toBeNull();
    expect(firstName(' Abdul  Koroma ')).toBe('Abdul');
  });
});
