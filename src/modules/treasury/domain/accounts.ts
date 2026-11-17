/**
 * Our provisioning keys. Used as the Monime financial account `reference`
 * (unique per Space, ≤ 64 chars), so provisioning is idempotent forever, not
 * just within the Idempotency-Key window.
 */
export const PLATFORM_ACCOUNT_REFERENCE = 'unimak-platform';

export function feeTypeAccountReference(feeTypeCode: string): string {
  return `unimak-fee-${feeTypeCode.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`.slice(0, 64);
}

export function feeTypeAccountName(feeTypeName: string): string {
  return `UNIMAK ${feeTypeName}`.slice(0, 100);
}
