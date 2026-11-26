import { aliasMatches, canonicalAlias, maskAlias } from './user-alias';

describe('X-User-Alias', () => {
  it('treats the usual ways of writing a Sierra Leone number as the same', () => {
    const forms = ['+232 76 123456', '076123456', '23276123456', '0023276123456', '+232-76-123-456', '76123456'];
    for (const f of forms) expect(canonicalAlias(f)).toEqual({ kind: 'phone', value: '76123456' });
  });

  it('matches against the phone on record', () => {
    expect(aliasMatches(canonicalAlias('076123456')!, { phone: '+23276123456' })).toBe(true);
    expect(aliasMatches(canonicalAlias('076123457')!, { phone: '+23276123456' })).toBe(false);
    expect(aliasMatches(canonicalAlias('076123456')!, { phone: null })).toBe(false);
  });

  it('keeps foreign numbers whole', () => {
    expect(canonicalAlias('+44 7700 900123')).toEqual({ kind: 'phone', value: '447700900123' });
    expect(aliasMatches(canonicalAlias('+44 7700 900123')!, { phone: '+23276123456' })).toBe(false);
  });

  it('matches an email against the payer’s email, ignoring case and spaces', () => {
    expect(canonicalAlias('  Aminata@Example.COM ')).toEqual({ kind: 'email', value: 'aminata@example.com' });
    const payer = { phone: '+23276123456', email: 'aminata@example.com' };
    expect(aliasMatches(canonicalAlias(' Aminata@Example.COM')!, payer)).toBe(true);
    expect(aliasMatches(canonicalAlias('other@example.com')!, payer)).toBe(false);
    expect(aliasMatches(canonicalAlias('a@b.co')!, { phone: '+23276123456', email: null })).toBe(false);
    // a phone alias never matches through the email and vice versa
    expect(aliasMatches(canonicalAlias('076123456')!, { phone: null, email: '76123456@x.co' })).toBe(false);
  });

  it('rejects junk', () => {
    for (const v of ['', '   ', 'hello', '12', '+232 76 12345678901234', 'x'.repeat(300)]) expect(canonicalAlias(v)).toBeNull();
    expect(canonicalAlias(undefined)).toBeNull();
  });

  it('masks for logs', () => {
    expect(maskAlias('+232 76 123456')).toBe('*****456');
    expect(maskAlias('aminata@example.com')).toBe('a***@example.com');
    expect(maskAlias('nope')).toBe('(unreadable)');
  });
});
