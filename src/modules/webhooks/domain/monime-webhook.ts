/**
 * Monime webhook envelope (API caph.2025-08-23):
 *   { apiVersion, event: { id, name, timestamp }, object: { id, type }, data }
 * event.id is stable across redeliveries (our dedupe key).
 *
 * payment.processing_completed → data is the Payment object:
 *   { id, status, amount: { currency, value }, financialAccountId, reference,
 *     metadata, fees: [{ code, amount }], ownershipGraph: { owner: { id, type, metadata } } }
 * All payload-shape knowledge lives in this file.
 */
import { toInternationalMsisdn } from '../../../shared/domain/phone';

export const PAYMENT_COMPLETED_EVENT = 'payment.processing_completed';

/** Events we subscribe to (see scripts: pnpm monime:register-webhook). */
export const MONIME_EVENTS = {
  paymentCompleted: 'payment.processing_completed',
  transferCompleted: 'internal_transfer.completed',
  transferFailed: 'internal_transfer.failed',
  payoutCompleted: 'payout.completed',
  payoutFailed: 'payout.failed',
  accountCredited: 'financial_account.credited',
  accountDebited: 'financial_account.debited',
} as const;
export const SUBSCRIBED_EVENTS: string[] = Object.values(MONIME_EVENTS);

export interface MonimeWebhookEnvelope {
  apiVersion: string | null;
  event: { id: string; name: string; timestamp: string | null };
  object: { id: string | null; type: string | null };
  data: Record<string, unknown>;
}

export interface ParsedCompletedPayment {
  monimePaymentId: string;
  financialAccountId: string | null;
  currency: string;
  amount: bigint;
  fees: bigint;
  reference: string | null;
  metadata: Record<string, string>;
  ownerId: string | null;
  ownerType: string | null;
  /** the paying number (channel.phoneNumber for momo), international format */
  payerPhone: string | null;
}

export class InvalidWebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWebhookPayloadError';
  }
}

export function parseMonimeWebhook(body: unknown): MonimeWebhookEnvelope {
  const root = asRecord(body, 'body');
  const event = asRecord(root['event'], 'event');
  const object = optionalRecord(root['object']);
  const id = asString(event['id']);
  const name = asString(event['name']);
  if (!id || !name) throw new InvalidWebhookPayloadError('event.id and event.name are required');
  if (id.length > 100 || name.length > 100) throw new InvalidWebhookPayloadError('event.id / event.name too long');
  return {
    apiVersion: asString(root['apiVersion']),
    event: { id, name, timestamp: asString(event['timestamp']) },
    object: { id: asString(object['id']), type: asString(object['type']) },
    data: optionalRecord(root['data']),
  };
}

export function parseCompletedPayment(env: MonimeWebhookEnvelope): ParsedCompletedPayment {
  const { data } = env;
  const monimePaymentId = asString(data['id']) ?? (env.object.type === 'payment' ? env.object.id : null);
  if (!monimePaymentId) throw new InvalidWebhookPayloadError('Missing payment id');
  const amount = asRecord(data['amount'], 'amount');
  const currency = asString(amount['currency']);
  const value = toMinor(amount['value']);
  if (!currency || value === null) throw new InvalidWebhookPayloadError('amount.currency and integer amount.value are required');
  if (value <= 0n) throw new InvalidWebhookPayloadError('amount.value must be positive');
  const owner = optionalRecord(optionalRecord(data['ownershipGraph'])['owner']);
  return {
    monimePaymentId,
    financialAccountId: asString(data['financialAccountId']),
    currency,
    amount: value,
    fees: sumFees(data['fees'], currency),
    reference: asString(data['reference']),
    metadata: { ...asStringRecord(owner['metadata']), ...asStringRecord(data['metadata']) },
    ownerId: asString(owner['id']),
    ownerType: asString(owner['type']),
    payerPhone: toInternationalMsisdn(asString(optionalRecord(data['channel'])['phoneNumber']) ?? ''),
  };
}

export interface Failure {
  code: string;
  message: string | null;
}

/** internal_transfer.* — data is the InternalTransfer object. */
export interface ParsedTransferUpdate {
  monimeTransferId: string;
  amount: bigint | null;
  failure: Failure | null;
  metadata: Record<string, string>;
}

export function parseInternalTransfer(env: MonimeWebhookEnvelope): ParsedTransferUpdate {
  const { data } = env;
  const id = asString(data['id']) ?? (env.object.type === 'internal_transfer' ? env.object.id : null);
  if (!id) throw new InvalidWebhookPayloadError('Missing internal transfer id');
  return { monimeTransferId: id, amount: optionalAmount(data['amount']), failure: failureOf(data['failureDetail']), metadata: asStringRecord(data['metadata']) };
}

/** payout.* — data is the Payout object. */
export interface ParsedPayoutUpdate {
  monimePayoutId: string;
  amount: bigint | null;
  fees: bigint;
  failure: Failure | null;
  metadata: Record<string, string>;
}

export function parsePayout(env: MonimeWebhookEnvelope): ParsedPayoutUpdate {
  const { data } = env;
  const id = asString(data['id']) ?? (env.object.type === 'payout' ? env.object.id : null);
  if (!id) throw new InvalidWebhookPayloadError('Missing payout id');
  return {
    monimePayoutId: id,
    amount: optionalAmount(data['amount']),
    fees: sumFees(data['fees'], 'SLE'),
    failure: failureOf(data['failureDetail']),
    metadata: asStringRecord(data['metadata']),
  };
}

/**
 * financial_account.credited / .debited. Not in Monime's public docs; the event
 * comes from Monime's internal financialaccount AccountEvent:
 *   { account: Account, credited|debited: { transaction_id, transaction_reference,
 *     amount: Money, new_balance: Money, credit_time|debit_time, metadata } }
 * (see hq-txn-monitor AccountEventDeserializer). We read its camelCase JSON form
 * first and keep older guesses as fallbacks; never throws.
 */
export interface ParsedAccountMovement {
  accountId: string | null;
  amount: bigint | null;
  balanceAfter: bigint | null;
  transactionId: string | null;
  transactionReference: string | null;
  /** credit_time / debit_time, if present */
  at: Date | null;
}

export function parseAccountMovement(env: MonimeWebhookEnvelope): ParsedAccountMovement {
  const { data } = env;
  // The movement may be at the top level or nested under credited/debited.
  const mv = { ...data, ...optionalRecord(data['credited']), ...optionalRecord(data['debited']) };
  const account = optionalRecord(data['account']);
  const fa = optionalRecord(data['financialAccount']);
  const isAccount = (v: string | null) => (v && v.startsWith('fac-') ? v : null);
  const accountId =
    (env.object.type === 'financial_account' ? isAccount(env.object.id) : null) ??
    isAccount(asString(account['id'])) ??
    isAccount(asString(fa['id'])) ??
    isAccount(asString(mv['financialAccountId'])) ??
    isAccount(asString(data['id']));
  const money = (v: unknown) => {
    const m = optionalRecord(v);
    return m['currency'] === undefined || m['currency'] === 'SLE' ? toMinor(m['value']) : null;
  };
  const balanceAfter =
    money(mv['newBalance']) ??
    money(mv['new_balance']) ??
    money(optionalRecord(fa['balance'])['after']) ??
    money(optionalRecord(optionalRecord(account['balance']))['available']) ??
    money(optionalRecord(data['balance'])['available']);
  const time = asString(mv['creditTime']) ?? asString(mv['debitTime']) ?? asString(mv['credit_time']) ?? asString(mv['debit_time']);
  const at = time ? new Date(time) : null;
  return {
    accountId,
    amount: money(mv['amount']),
    balanceAfter,
    transactionId: asString(mv['transactionId']) ?? asString(mv['transaction_id']),
    transactionReference: asString(mv['transactionReference']) ?? asString(mv['transaction_reference']),
    at: at && !Number.isNaN(at.getTime()) ? at : null,
  };
}

function optionalAmount(v: unknown): bigint | null {
  const a = optionalRecord(v);
  return a['currency'] === 'SLE' ? toMinor(a['value']) : null;
}

function failureOf(v: unknown): Failure | null {
  const f = optionalRecord(v);
  const code = asString(f['code']);
  return code ? { code, message: asString(f['message']) ?? asString(f['explanation']) } : null;
}

/** event.timestamp is Unix seconds as a string per the docs; also accepts ms and ISO. */
export function eventTime(env: MonimeWebhookEnvelope, fallback: Date): Date {
  const raw = env.event.timestamp;
  if (!raw) return fallback;
  const t = /^\d+$/.test(raw) ? new Date(Number(raw) > 1e12 ? Number(raw) : Number(raw) * 1000) : new Date(raw);
  return Number.isNaN(t.getTime()) ? fallback : t;
}

function sumFees(value: unknown, currency: string): bigint {
  if (!Array.isArray(value)) return 0n;
  let total = 0n;
  for (const item of value) {
    const a = optionalRecord(optionalRecord(item)['amount']);
    if (a['currency'] !== currency) continue;
    const v = toMinor(a['value']);
    if (v !== null && v > 0n) total += v;
  }
  return total;
}

function toMinor(raw: unknown): bigint | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) ? BigInt(raw) : null;
  if (typeof raw === 'string' && /^-?\d{1,18}$/.test(raw)) return BigInt(raw);
  return null;
}

function asRecord(v: unknown, field: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new InvalidWebhookPayloadError(`${field} must be an object`);
  return v as Record<string, unknown>;
}

function optionalRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number') return String(v);
  return null;
}

function asStringRecord(v: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(optionalRecord(v))
      .map(([k, x]) => [k, asString(x)] as const)
      .filter((e): e is [string, string] => e[1] !== null),
  );
}
