import { MINOR_PER_SLE, type Minor } from '../../../shared/domain/money';

/**
 * A sponsor pays a pay request in a browser (docs/dot-extras.md §3a): our page at
 * /p/{code}, then Monime's hosted checkout for the method they pick.
 */
export type SponsorMethod = 'card' | 'momo';
export const SPONSOR_METHODS: readonly SponsorMethod[] = ['momo', 'card'];
export const isSponsorMethod = (s: unknown): s is SponsorMethod => s === 'card' || s === 'momo';

/** clientId on payments started from the web page (idempotency scope). */
export const SPONSOR_CLIENT_ID = 'web-sponsor';
/** Checkout pages one request link may open per hour. */
export const CHECKOUTS_PER_REQUEST_PER_HOUR = 10;
export const SPONSOR_NAME_MAX = 40;

/** The page's one-time form key: a double submit gets the same hosted page. */
export const isCheckoutKey = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{16,40}$/.test(s);

export function payRequestWebUrl(publicBaseUrl: string, code: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/p/${encodeURIComponent(code)}`;
}

/** "1,500" / "1500.5" / "SLE 1,500.50" → minor units; null if not a positive amount with ≤ 2 decimals. */
export function parseSleInput(text: unknown): Minor | null {
  if (typeof text !== 'string') return null;
  const t = text.trim().replace(/^SLE\s*/i, '').replace(/,/g, '');
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const v = BigInt(m[1]!) * MINOR_PER_SLE + BigInt((m[2] ?? '').padEnd(2, '0'));
  return v > 0n ? v : null;
}

export interface SponsorAmountInput {
  /** the request's amount; null = "whatever you can" */
  requested: Minor | null;
  /** already paid through this request */
  paid: Minor;
  /** what the fee can take now */
  payable: Minor;
  /** what the sponsor typed (only for "whatever you can") */
  entered: Minor | null;
}

export type SponsorAmount = { ok: true; amount: Minor } | { ok: false; message: string };

/**
 * A fixed request pays what is left of it (never more than the fee can take); an open one
 * pays what the sponsor typed, up to what the fee can take. Minimum instalments are checked
 * when the payment is created.
 */
export function sponsorAmount(i: SponsorAmountInput): SponsorAmount {
  if (i.payable <= 0n) return { ok: false, message: 'Nothing is left to pay on this fee.' };
  if (i.requested !== null) {
    const left = i.requested - i.paid;
    if (left <= 0n) return { ok: false, message: 'This request has already been paid.' };
    return { ok: true, amount: left < i.payable ? left : i.payable };
  }
  if (i.entered === null) return { ok: false, message: 'Enter the amount you want to pay.' };
  if (i.entered > i.payable) return { ok: false, message: 'That is more than is owed on this fee.' };
  return { ok: true, amount: i.entered };
}

/** The fixed amount the page shows, or null when the sponsor chooses. */
export function sponsorDue(requested: Minor | null, paid: Minor, payable: Minor): Minor | null {
  const r = sponsorAmount({ requested, paid, payable, entered: null });
  return requested !== null && r.ok ? r.amount : null;
}
