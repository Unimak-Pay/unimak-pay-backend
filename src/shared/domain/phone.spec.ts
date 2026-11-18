import { isMaskedMsisdn, matchesMaskedMsisdn, toInternationalMsisdn, ussdSubscriberIdFor } from './phone';

describe('phone', () => {
  it('normalizes Sierra Leone numbers', () => {
    expect(toInternationalMsisdn('076123456')).toBe('+23276123456');
    expect(toInternationalMsisdn('23276123456')).toBe('+23276123456');
    expect(toInternationalMsisdn('+23276****56')).toBeNull();
  });

  it('computes the USSD subscriberId like Monime (docs test pair)', () => {
    expect(ussdSubscriberIdFor('+23276123456')).toBe('c9b4e86f-a1d8-5056-8dc4-5d1aafc6994a');
  });

  it('recognizes and matches masked numbers', () => {
    expect(isMaskedMsisdn('+23276****56')).toBe(true);
    expect(isMaskedMsisdn('+23276123456')).toBe(false);
    expect(matchesMaskedMsisdn('+23276123456', '+23276****56')).toBe(true);
    expect(matchesMaskedMsisdn('+23277123456', '+23276****56')).toBe(false);
  });
});
