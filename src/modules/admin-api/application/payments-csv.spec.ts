import { cell, sle } from './payments-csv';

describe('payments CSV', () => {
  it('formats SLE from minor units', () => {
    expect([sle(150000n), sle(5n), sle(0n), sle(-12345n)]).toEqual(['1500.00', '0.05', '0.00', '-123.45']);
  });
  it('quotes per RFC 4180 and defuses formulas', () => {
    expect(cell('plain')).toBe('plain');
    expect(cell('a,b')).toBe('"a,b"');
    expect(cell('say "hi"')).toBe('"say ""hi"""');
    expect(cell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(cell('+23276****56')).toBe("'+23276****56");
    expect(cell(null)).toBe('');
    expect(cell(-5)).toBe('-5');
  });
});
