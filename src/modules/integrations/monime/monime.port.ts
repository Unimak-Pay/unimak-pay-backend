/**
 * Port to Monime (API caph.2025-08-23). Shapes follow Monime's objects with
 * bigint minor units; adapters map to/from the wire format.
 * Reference: https://docs.monime.io/apis/openapi/caph-2025-08-23.json
 */
export const MONIME_CLIENT = Symbol('MonimeClient');

export type Currency = 'SLE';

// ── Payment codes (USSD collections) ─────────────────────────────────────────

export type PaymentCodeStatus = 'pending' | 'processing' | 'completed' | 'expired' | 'cancelled';

export interface CreatePaymentCodeInput {
  idempotencyKey: string;
  /** 3–64 chars, shown to the payer */
  name: string;
  amount: bigint;
  durationMinutes: number;
  /** our payment id (≤ 64 chars) */
  reference: string;
  /** only this MSISDN may pay the code */
  authorizedPhoneNumber?: string;
  /** settlement financial account (fac-…) */
  financialAccountId: string;
  metadata: Record<string, string>;
}

export interface PaymentCodeView {
  id: string;
  status: PaymentCodeStatus;
  ussdCode: string | null;
  expireTime: string | null;
  reference: string | null;
  amount: bigint;
}

// ── Payments (what Monime collected) ────────────────────────────────────────

/** A Monime Payment object (GET /v1/payments). */
export interface MonimePaymentRecord {
  id: string;
  status: 'pending' | 'processing' | 'completed';
  currency: string;
  amount: bigint;
  financialAccountId: string | null;
  reference: string | null;
  /** payment metadata merged over its owner's */
  metadata: Record<string, string>;
  ownerId: string | null;
  fees: bigint;
  /** channel number as Monime reports it (usually masked) */
  payerPhone: string | null;
  orderNumber: string | null;
  createTime: Date;
  updateTime: Date | null;
}

export interface MonimePage<T> {
  items: T[];
  next: string | null;
}

// ── Financial accounts ───────────────────────────────────────────────────────

export interface CreateFinancialAccountInput {
  idempotencyKey: string;
  /** ≤ 100 chars */
  name: string;
  currency: Currency;
  /** unique per Space (≤ 64 chars) — our provisioning key */
  reference: string;
  description?: string;
  metadata?: Record<string, string>;
}

export interface FinancialAccountView {
  id: string;
  uvan: string | null;
  name: string;
  currency: string;
  reference: string | null;
  /** available balance in minor units; null unless requested */
  available: bigint | null;
}

// ── Internal transfers ───────────────────────────────────────────────────────

export type InternalTransferStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface CreateInternalTransferInput {
  idempotencyKey: string;
  amount: bigint;
  sourceAccountId: string;
  destinationAccountId: string;
  metadata: Record<string, string>;
}

export interface InternalTransferView {
  id: string;
  status: InternalTransferStatus;
  amount: bigint;
  failure: { code: string; message: string | null } | null;
}

// ── Payouts ──────────────────────────────────────────────────────────────────

export type PayoutStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type PayoutDestination =
  | { type: 'bank'; providerId: string; accountNumber: string }
  | { type: 'momo'; providerId: string; phoneNumber: string };

export interface CreatePayoutInput {
  idempotencyKey: string;
  amount: bigint;
  sourceAccountId: string;
  destination: PayoutDestination;
  metadata: Record<string, string>;
}

export interface PayoutView {
  id: string;
  status: PayoutStatus;
  amount: bigint;
  /** sum of Monime fees (SLE) */
  fees: bigint;
  failure: { code: string; message: string | null } | null;
}

export interface BankView {
  providerId: string;
  name: string;
  active: boolean;
  canPayTo: boolean;
}

// ── Webhooks ─────────────────────────────────────────────────────────────────

export interface CreateWebhookInput {
  idempotencyKey: string;
  name: string;
  url: string;
  events: string[];
  /** HS256 shared secret, 32–256 chars */
  secret: string;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type MonimeErrorCode = 'UNAVAILABLE' | 'REJECTED' | 'NOT_FOUND' | 'BAD_RESPONSE';

export class MonimeError extends Error {
  constructor(
    readonly code: MonimeErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MonimeError';
  }
}

export interface MonimeClient {
  createPaymentCode(input: CreatePaymentCodeInput): Promise<PaymentCodeView>;
  getPaymentCode(id: string): Promise<PaymentCodeView>;

  /** Payments received into an account. TODO(monime): ordering isn't documented. */
  listPayments(q: { financialAccountId: string; after?: string | null; limit?: number }): Promise<MonimePage<MonimePaymentRecord>>;
  getPayment(id: string): Promise<MonimePaymentRecord>;

  createFinancialAccount(input: CreateFinancialAccountInput): Promise<FinancialAccountView>;
  getFinancialAccount(id: string, opts?: { withBalance?: boolean }): Promise<FinancialAccountView>;
  findFinancialAccountByReference(reference: string): Promise<FinancialAccountView | null>;

  createInternalTransfer(input: CreateInternalTransferInput): Promise<InternalTransferView>;
  getInternalTransfer(id: string): Promise<InternalTransferView>;

  createPayout(input: CreatePayoutInput): Promise<PayoutView>;
  getPayout(id: string): Promise<PayoutView>;
  listBanks(country: string): Promise<BankView[]>;

  createWebhook(input: CreateWebhookInput): Promise<{ id: string }>;
}
