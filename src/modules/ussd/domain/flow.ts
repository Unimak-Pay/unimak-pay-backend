/**
 * Page ids of the UNIMAK USSD flow (must match ussd/unimak-flow.template.json).
 * Menus and prompts are static in the flow; pages with on_done "exchange" call
 * us and we answer navigate/stop. make_payment is Monime's collect_payment
 * template: the subscriber authorises with their mobile money PIN in-session.
 */
export const PAGES = {
  home: 'home',
  idType: 'id_type',
  enterStudentId: 'enter_student_id',
  enterApplicationRef: 'enter_application_ref',
  tryAgain: 'try_again',
  confirmPayer: 'confirm_payer',
  selectFee: 'select_fee',
  enterAmount: 'enter_amount',
  confirmPayment: 'confirm_payment',
  makePayment: 'make_payment',
  paymentStarted: 'payment_started',
  paymentCancelled: 'payment_cancelled',
} as const;
export type PageId = (typeof PAGES)[keyof typeof PAGES];

export type Intent = 'pay' | 'balance' | 'resend';

/** Server-side session state; flowData from Monime is only input, never state. */
export interface SessionState {
  /** the page we expect the next exchange from ('done' when finished) */
  expect: PageId | 'done';
  intent?: Intent;
  kind?: 'APPLICANT' | 'STUDENT';
  ref?: string;
  idAttempts: number;
  amountAttempts: number;
  /** where try_again → "Try again" leads, with the page data to re-send */
  retry?: { pageId: PageId; pageData: Record<string, unknown> };
  /** menu value → obligation id, as offered on select_fee */
  feeOptions?: Record<string, string>;
  obligationId?: string;
  feeName?: string;
  /** minor units as strings */
  amount?: string;
  min?: string;
  max?: string;
  paymentId?: string;
}

export interface ExchangeRequest {
  global: { sessionId: string; subscriberId: string; subscriberMsisdn?: string; networkName?: string; networkProviderName?: string };
  currentPage: string;
  flowData: Record<string, string>;
  exportedData?: Record<string, string | number | boolean>;
}

export type ExchangeReply =
  | { action: 'navigate'; pageId: PageId; pageData?: Record<string, unknown> }
  | { action: 'stop'; message: string };

export const MAX_ID_RETRIES = 2;
export const MAX_AMOUNT_RETRIES = 2;

export function parseExchangeRequest(raw: unknown): ExchangeRequest | null {
  const r = raw as Partial<ExchangeRequest> | null;
  const g = r?.global;
  if (!r || !g || typeof g.sessionId !== 'string' || typeof g.subscriberId !== 'string' || typeof r.currentPage !== 'string') return null;
  if (g.sessionId.length > 100 || g.subscriberId.length > 100 || r.currentPage.length > 64) return null;
  const flowData: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.flowData ?? {})) if (typeof v === 'string' && v.length <= 200) flowData[k] = v;
  return { global: g, currentPage: r.currentPage, flowData, exportedData: r.exportedData ?? {} };
}

/** "1500" / "1,500" / "1500.5" SLE → minor units. */
export function parseSleInput(raw: string): bigint | null {
  const s = raw.trim().replace(/,/g, '');
  const m = /^(\d{1,12})(?:[.*](\d{1,2}))?$/.exec(s); // '*' is the decimal key on some phones
  if (!m) return null;
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '0').padEnd(2, '0'));
}

/** Short SLE for 160-char screens: "SLE 4,500" or "SLE 4,500.50". */
export function sleShort(minor: bigint): string {
  const whole = (minor / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = minor % 100n;
  return `SLE ${whole}${cents ? `.${cents.toString().padStart(2, '0')}` : ''}`;
}

/** collect_payment takes the amount in major units: 250000 → "2500", 250050 → "2500.50". */
export function toMajorAmount(minor: bigint): string {
  const cents = minor % 100n;
  return `${minor / 100n}${cents ? `.${cents.toString().padStart(2, '0')}` : ''}`;
}
