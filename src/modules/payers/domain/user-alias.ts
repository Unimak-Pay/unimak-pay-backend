import { maskEmail } from '../../../shared/domain/mask';

/**
 * The dot's X-User-Alias (docs/dot-extras.md): the Dash account's phone number, or its
 * email when it has no phone. A check, not proof: the dot sets it itself.
 */
export type CanonicalAlias = { kind: 'phone'; value: string } | { kind: 'email'; value: string };

const SL_COUNTRY = '232';

/**
 * Phones compare on their national number, so "+232 76 123456", "076123456",
 * "0023276123456" and "23276123456" are the same. Non-Sierra-Leone numbers compare
 * on all their digits. Emails compare trimmed and lower-cased.
 */
export function canonicalAlias(raw: string | null | undefined): CanonicalAlias | null {
  const s = (raw ?? '').trim();
  if (!s || s.length > 254) return null;
  if (s.includes('@')) return { kind: 'email', value: s.toLowerCase() };
  if (!/^[+\d\s().-]+$/.test(s)) return null;
  let d = s.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith(SL_COUNTRY) && d.length === 11) d = d.slice(3);
  else if (d.startsWith('0') && d.length === 9) d = d.slice(1);
  return d.length >= 6 && d.length <= 15 ? { kind: 'phone', value: d } : null;
}

/** A phone alias matches the payer's phone; an email alias their email (case-insensitive). */
export function aliasMatches(alias: CanonicalAlias, payer: { phone: string | null | undefined; email?: string | null }): boolean {
  const own = canonicalAlias(alias.kind === 'phone' ? payer.phone : payer.email);
  return own?.kind === alias.kind && own.value === alias.value;
}

/** For logs: "*****456" or "a***@example.com". Never log an alias in full. */
export function maskAlias(raw: string): string {
  const a = canonicalAlias(raw);
  if (!a) return '(unreadable)';
  if (a.kind === 'email') return maskEmail(a.value) ?? '(unreadable)';
  return `${'*'.repeat(a.value.length - 3)}${a.value.slice(-3)}`;
}
