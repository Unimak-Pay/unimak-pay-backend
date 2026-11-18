/** Normalizes an MSISDN to international format with "+" (Sierra Leone default country code 232). */
export function toInternationalMsisdn(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, '');
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  if (/^232\d{8}$/.test(digits)) return `+${digits}`;
  if (/^0\d{8}$/.test(digits)) return `+232${digits.slice(1)}`;
  return null;
}
