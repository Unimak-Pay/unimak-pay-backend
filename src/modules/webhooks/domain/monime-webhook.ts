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
 * financial_account.credited / .debited — payload NOT documented by Monime.
 * Lenient on purpose (never throws): reads the account id and balance from the
 * shapes the spec suggests (FinancialTransaction or FinancialAccount).
 */
export interface ParsedAccountMovement {
  accountId: string | null;
  amount: bigint | null;
  balanceAfter: bigint | null;
}

export function parseAccountMovement(env: MonimeWebhookEnvelope): ParsedAccountMovement {
  const { data } = env;
  const fa = optionalRecord(data['financialAccount']);
  const isAccount = (v: string | null) => (v && v.startsWith('fac-') ? v : null);
  const accountId =
    isAccount(asString(fa['id'])) ??
    isAccount(asString(data['financialAccountId'])) ??
    (env.object.type === 'financial_account' ? env.object.id : null) ??
    isAccount(asString(data['id']));
  const after =
    optionalRecord(optionalRecord(fa['balance'])['after'])['value'] ??
    optionalRecord(optionalRecord(data['balance'])['available'])['value'];
  return { accountId, amount: optionalAmount(data['amount']), balanceAfter: toMinor(after) };
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
