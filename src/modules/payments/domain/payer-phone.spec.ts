import { resolvePayerPhone } from './payer-phone';

describe('resolvePayerPhone', () => {
  it('prefers the full number in metadata', () => {
    expect(resolvePayerPhone({ metadata: { payer_phone: '+23276123456' }, reported: '+23276****56', current: null })).toBe('+23276123456');
  });
  it('uses an unmasked channel number', () => {
    expect(resolvePayerPhone({ metadata: {}, reported: '+23277000001', current: '+23276123456' })).toBe('+23277000001');
  });
  it('keeps our number when it fits the mask, else stores the masked one', () => {
    expect(resolvePayerPhone({ metadata: {}, reported: '+23276****56', current: '+23276123456' })).toBe('+23276123456');
    expect(resolvePayerPhone({ metadata: {}, reported: '+23299****01', current: '+23276123456' })).toBe('+23299****01');
    expect(resolvePayerPhone({ metadata: {}, reported: '+23299****01', current: null })).toBe('+23299****01');
  });
  it('keeps what we had when Monime reports nothing', () => {
    expect(resolvePayerPhone({ metadata: {}, reported: null, current: '+23276123456' })).toBe('+23276123456');
  });
});
