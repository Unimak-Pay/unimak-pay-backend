import { createHash } from 'node:crypto';

/** RFC 4122 URL namespace (6ba7b811-9dad-11d1-80b4-00c04fd430c8). */
const URL_NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');

/** uuidv5(name, URL namespace) — how Monime derives global.subscriberId from the MSISDN. */
export function uuidv5Url(name: string): string {
  const hash = createHash('sha1').update(URL_NAMESPACE).update(name, 'utf8').digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Normalizes to international format with "+" (Sierra Leone default country code 232). */
export function toInternationalMsisdn(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, '');
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  if (/^232\d{8}$/.test(digits)) return `+${digits}`;
  if (/^0\d{8}$/.test(digits)) return `+232${digits.slice(1)}`;
  return null;
}

/** True only if `msisdn` is the subscriber's own number (prevents exported-data tampering). */
export function msisdnMatchesSubscriber(msisdn: string, subscriberId: string): boolean {
  const intl = toInternationalMsisdn(msisdn);
  return intl !== null && uuidv5Url(intl) === subscriberId.toLowerCase();
}
