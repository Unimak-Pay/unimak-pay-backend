/** Our payment ref: 8 digits, no leading zero — easy to type on a USSD keypad. */
export const PAYMENT_REF = /^[1-9]\d{7}$/;
/** Monime order number as printed in its SMS, e.g. 3BMRXXXQXJW3. */
export const MONIME_ORDER_NUMBER = /^[A-Z0-9]{6,20}$/;

/** Normalizes what a payer types or pastes ("3bmr-xxxq xjw3" → "3BMRXXXQXJW3"); null if neither form. */
export function normalizePublicRef(raw: string): string | null {
  const ref = raw.toUpperCase().replace(/[\s-]/g, '');
  return PAYMENT_REF.test(ref) || MONIME_ORDER_NUMBER.test(ref) ? ref : null;
}
