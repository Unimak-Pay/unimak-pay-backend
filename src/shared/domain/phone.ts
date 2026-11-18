import { createHash } from 'node:crypto';


/** Normalizes an MSISDN to international format with "+" (Sierra Leone default country code 232). */
export function toInternationalMsisdn(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, '');
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  if (/^232\d{8}$/.test(digits)) return `+${digits}`;
  if (/^0\d{8}$/.test(digits)) return `+232${digits.slice(1)}`;
  return null;
}

/** RFC 4122 URL namespace (6ba7b811-9dad-11d1-80b4-00c04fd430c8). */
const URL_NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');

/**
 * Monime's USSD subscriberId is uuidv5(msisdn, uuidv5.URL), e.g.
 * +23276123456 → c9b4e86f-a1d8-5056-8dc4-5d1aafc6994a (Monime docs). It lets us
 * check a number we already have without asking the subscriber for it.
 */
export function ussdSubscriberIdFor(msisdn: string): string {
  const h = createHash('sha1').update(URL_NAMESPACE).update(msisdn, 'utf8').digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** Monime masks payer numbers, e.g. "+23276****56". */
export function isMaskedMsisdn(raw: string): boolean {
  return /^\+?\d{3,}\*+\d+$/.test(raw.replace(/[\s-]/g, ''));
}

/** Does a full number fit a masked one ("+23276****56")? */
export function matchesMaskedMsisdn(full: string, masked: string): boolean {
  const m = masked.replace(/[\s-]/g, '');
  if (m.length !== full.length) return false;
  return [...m].every((c, i) => c === '*' || c === full[i]);
}

/** A number as Monime reports it: full (normalized) or masked (kept as is); null if neither. */
export function reportedMsisdn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.replace(/[\s-]/g, '');
  return isMaskedMsisdn(v) ? v : toInternationalMsisdn(v);
}
