import { randomInt } from 'node:crypto';

/** UNIMAK-YYYY-NNNNNN */
export function formatReceiptNumber(year: number, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > 999_999) {
    throw new RangeError(`Receipt sequence out of range: ${seq}`);
  }
  return `UNIMAK-${year}-${String(seq).padStart(6, '0')}`;
}

/** No 0/O/1/I/L to keep codes readable over the phone. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** 10 chars ≈ 49 bits: unguessable enough for a public "is this receipt real" page. */
export function generateVerifyCode(length = 10): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function isVerifyCodeShape(code: string): boolean {
  return new RegExp(`^[${ALPHABET}]{6,20}$`).test(code);
}
