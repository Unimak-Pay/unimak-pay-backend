import { parseExchangeRequest, parseSleInput, sleShort } from './flow';

describe('USSD flow helpers', () => {
  it('parses keypad amounts into minor units', () => {
    expect(parseSleInput('1500')).toBe(150_000n);
    expect(parseSleInput('1,500.5')).toBe(150_050n);
    expect(parseSleInput('1500*25')).toBe(150_025n);
    expect(parseSleInput('abc')).toBeNull();
    expect(parseSleInput('1.234')).toBeNull();
    expect(parseSleInput('-5')).toBeNull();
  });
  it('formats short amounts', () => {
    expect(sleShort(450_000n)).toBe('SLE 4,500');
    expect(sleShort(450_050n)).toBe('SLE 4,500.50');
  });
  it('validates the exchange request shape and drops non-string flowData', () => {
    expect(parseExchangeRequest({ currentPage: 'start' })).toBeNull();
    expect(parseExchangeRequest({ global: { sessionId: 's', subscriberId: 'u' }, currentPage: 'x', flowData: { a: '1', b: 2 } })?.flowData).toEqual({ a: '1' });
  });
});
