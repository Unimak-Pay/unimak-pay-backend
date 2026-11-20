import { maskName, maskPhone, shortName } from './mask';

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
