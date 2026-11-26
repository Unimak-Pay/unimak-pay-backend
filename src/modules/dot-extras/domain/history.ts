/** Payment history and receipts for the dot (docs/dot-extras.md §1-2). */

/**
 * Monime's Payment `channel.type` (bank | card | momo | wallet; caph.2025-08-23) as the
 * dot shows it. Provider ids (m17, m18, …) aren't documented as network names, so
 * they're not mapped.
 */
export function paymentMethodLabel(channelType: string | null | undefined): string | null {
  switch (channelType) {
    case 'momo': return 'Mobile money';
    case 'card': return 'Card';
    case 'bank': return 'Bank';
    case 'wallet': return 'Wallet';
    default: return null;
  }
}

const ACADEMIC_YEAR = /^\d{4}\/\d{2}$/;

/**
 * The payer's academic year, from their obligations' periods: the latest "2026/27"
 * style period, else the latest period of any kind (applicants: "2026-SEP"); null
 * with no obligations.
 */
export function academicYearOf(periods: readonly string[]): string | null {
  const years = periods.filter((p) => ACADEMIC_YEAR.test(p)).sort();
  if (years.length) return years[years.length - 1]!;
  const any = [...periods].sort();
  return any.length ? any[any.length - 1]! : null;
}

export const HISTORY_RECENT_DAYS = 30;

/**
 * Which payments the history lists: every completed one, every one still open, and
 * failed or expired ones from the last 30 days. An open payment past its expiry is
 * already EXPIRED (the sweep may not have run).
 */
export function shownInHistory(p: { status: string; expiresAt: Date; createdAt: Date }, now: Date): boolean {
  if (p.status === 'COMPLETED') return true;
  const open = (p.status === 'INITIATED' || p.status === 'PENDING') && p.expiresAt > now;
  return open || now.getTime() - p.createdAt.getTime() <= HISTORY_RECENT_DAYS * 86_400_000;
}
