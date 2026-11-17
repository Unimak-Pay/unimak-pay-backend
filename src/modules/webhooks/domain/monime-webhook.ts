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

export function eventTime(env: MonimeWebhookEnvelope, fallback: Date): Date {
  const t = env.event.timestamp ? new Date(env.event.timestamp) : null;
  return t && !Number.isNaN(t.getTime()) ? t : fallback;
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
