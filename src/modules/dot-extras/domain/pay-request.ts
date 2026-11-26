import { generateVerifyCode, isVerifyCodeShape } from '../../receipts/domain/receipt';

/** "Ask someone to pay" (docs/dot-extras.md). */
export const PAY_REQUEST_STATUSES = ['OPEN', 'PARTLY_PAID', 'PAID', 'CANCELLED', 'EXPIRED'] as const;
export type PayRequestStatus = (typeof PAY_REQUEST_STATUSES)[number];

export const PAY_REQUEST_CODE_LENGTH = 7;
export const MAX_OPEN_PAY_REQUESTS = 20;
export const MESSAGE_MAX = 280;
export const RECIPIENT_MAX = 60;

const DAY = 86_400_000;

export const newPayRequestCode = (): string => generateVerifyCode(PAY_REQUEST_CODE_LENGTH);
export const isPayRequestCode = (s: string): boolean => s.length === PAY_REQUEST_CODE_LENGTH && isVerifyCodeShape(s);

const endOfDayUtc = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59));

/**
 * 30 days, or the fee's due date if sooner, but never less than 3 days after
 * creation; always the end of that day (UTC).
 */
export function payRequestExpiry(createdAt: Date, dueDate: Date | null): Date {
  let at = new Date(createdAt.getTime() + 30 * DAY);
  if (dueDate && dueDate < at) at = dueDate;
  const floor = new Date(createdAt.getTime() + 3 * DAY);
  if (at < floor) at = floor;
  return endOfDayUtc(at);
}

export interface PayRequestState {
  cancelledAt: Date | null;
  expiresAt: Date;
  /** null = "whatever you can" */
  amount: bigint | null;
  /** sum of the request's COMPLETED payments */
  paid: bigint;
  /** the obligation has nothing left to pay */
  obligationPaid: boolean;
}

/**
 * Derived when read. A request closes as PAID when it reached its amount, or when the
 * fee is paid off and the request contributed; a fee paid off without it reads EXPIRED
 * (nothing is left to pay through it).
 */
export function payRequestStatus(s: PayRequestState, now: Date): PayRequestStatus {
  if (s.cancelledAt) return 'CANCELLED';
  if (s.amount !== null && s.paid >= s.amount) return 'PAID';
  if (s.obligationPaid) return s.paid > 0n ? 'PAID' : 'EXPIRED';
  if (now >= s.expiresAt) return 'EXPIRED';
  return s.paid > 0n ? 'PARTLY_PAID' : 'OPEN';
}

/** Can still be paid through. */
export const isPayable = (status: PayRequestStatus) => status === 'OPEN' || status === 'PARTLY_PAID';

/** `${dotLink}/sponsor?request=…&kind=…&ref=…&fee=…&amount=…`: exactly these options, in this order. */
export function payRequestShareUrl(dotLink: string, r: { code: string; kind: 'student' | 'applicant'; ref: string; obligationId: string; amount: bigint | null }): string {
  const q = new URLSearchParams({ request: r.code, kind: r.kind, ref: r.ref, fee: r.obligationId, amount: r.amount === null ? '' : r.amount.toString() });
  return `${dotLink.replace(/\/+$/, '')}/sponsor?${q.toString()}`;
}

/** Trims and drops control characters; null when empty. */
export function cleanText(s: string | null | undefined): string | null {
  const t = (s ?? '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
  return t ? t : null;
}

/** "Aminata Kamara" → "Aminata" (what a sponsor sees). */
export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? '';
}
