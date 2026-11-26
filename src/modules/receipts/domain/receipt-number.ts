/** "unimak 2026 000123", "UNIMAK-2026-000123" → "UNIMAK-2026-000123"; null if it isn't a receipt number. */
export function normalizeReceiptNumber(raw: string): string | null {
  const m = /^UNIMAK(\d{4})(\d{6})$/.exec(raw.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  return m ? `UNIMAK-${m[1]}-${m[2]}` : null;
}
