import { isMaskedMsisdn, matchesMaskedMsisdn, toInternationalMsisdn } from '../../../shared/domain/phone';

/** Metadata keys that may carry the full paying number (we set payer_phone). */
const METADATA_KEYS = ['payer_phone', 'payerPhone'];

/**
 * The number that actually paid, best first:
 *   1. full number in the payment metadata (an authorised payment code, or a USSD
 *      flow that put a verified number there),
 *   2. the channel number Monime reports, when it isn't masked,
 *   3. the number we already had, if it fits Monime's mask,
 *   4. Monime's masked number (+23276****56) — better than a number that didn't pay.
 */
export function resolvePayerPhone(a: { metadata: Record<string, string>; reported: string | null | undefined; current: string | null }): string | null {
  for (const k of METADATA_KEYS) {
    const full = toInternationalMsisdn(a.metadata[k] ?? '');
    if (full) return full;
  }
  const reported = a.reported ?? null;
  if (reported && !isMaskedMsisdn(reported)) return toInternationalMsisdn(reported) ?? a.current;
  if (reported) return a.current && !isMaskedMsisdn(a.current) && matchesMaskedMsisdn(a.current, reported) ? a.current : reported;
  return a.current;
}
