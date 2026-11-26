import { maskEmail, maskName, maskPhone, shortName } from './mask';

describe('name and phone masking', () => {
  it('shortName: first name + surname initial', () => {
    expect(shortName('Aminata Kamara')).toBe('Aminata K.');
    expect(shortName('  Mohamed Lamin  bangura ')).toBe('Mohamed B.');
    expect(shortName('Aminata')).toBe('Aminata');
    expect(shortName('   ')).toBe('');
  });

  it('maskName and maskPhone are unchanged', () => {
    expect(maskName('Aminata Kamara')).toBe('A*** K***');
    expect(maskPhone('+23276123456')).toBe('+232*****456');
  });
});

describe('maskEmail', () => {
  it('keeps the first letter and the domain', () => {
    expect(maskEmail('Aminata.Kamara@Gmail.com')).toBe('a***@gmail.com');
    expect(maskEmail(' a@b.co ')).toBe('a***@b.co');
  });
  it('null when there is no email', () => {
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail('')).toBeNull();
    expect(maskEmail('nope')).toBeNull();
    expect(maskEmail('@b.co')).toBeNull();
  });
});
