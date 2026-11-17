import { Logger } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type InitiateCollectionInput,
  type InitiateCollectionResult,
  type MonimeClient,
  MonimeError,
  type MonimePaymentView,
  type TransferInput,
  type TransferResult,
} from './monime.port';

export interface HttpMonimeConfig {
  /** Includes the version path, e.g. https://api.monime.io/v1 */
  baseUrl: string;
  accessToken: string;
  spaceId: string;
  apiVersion: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

const IDEMPOTENCY_KEY_MAX = 64;
const METADATA_MAX_KEYS = 64;
const METADATA_VALUE_MAX = 100;

/**
 * Monime REST adapter.
 *
 * Transport is confirmed (same as monime-put-n-put-api, API version
 * caph.2025-08-23): Bearer token, Monime-Space-Id, Monime-Version and
 * Idempotency-Key (≤ 64 chars) headers; responses are { success, messages, result };
 * amounts are { currency, value } in minor units. Network errors, 429 and 5xx are
 * retried with the same idempotency key.
 *
 * Endpoints for collections and account-to-account transfers are NOT confirmed
 * yet — see TODO(monime).
 */
export class HttpMonimeClient implements MonimeClient {
  private readonly logger = new Logger(HttpMonimeClient.name);

  constructor(private readonly cfg: HttpMonimeConfig) {}

  async initiateCollection(input: InitiateCollectionInput): Promise<InitiateCollectionResult> {
    // TODO(monime): which object starts a USSD / Dots collection for our channel API —
    //   payment code (POST /payment-codes)? checkout session? — and its body fields.
    // TODO(monime): how the destination financial account (input.settlementAccount) is set.
    // TODO(monime): whether Monime takes our expiry (input.expiresAt).
    // Whatever it is must carry `reference: <our payment id>` and our metadata, so
    // payment.processing_completed can be matched back (see MonimeWebhookReceiver).
    const result = await this.request<{ id: string }>('POST', '/TODO-monime-collection-endpoint', {
      idempotencyKey: input.reference,
      body: {
        reference: input.reference,
        amount: toAmount(input.amount),
        financialAccountId: input.settlementAccount,
        description: input.description,
        metadata: sanitizeMetadata(input.metadata),
      },
    });
    return { monimeRef: result.id, status: 'PENDING' };
  }

  async getPayment(monimeRef: string): Promise<MonimePaymentView> {
    // TODO(monime): confirm GET /payments/{id} accepts the id returned by initiateCollection,
    //   or whether we must query the collection object instead.
    const p = await this.request<{ id: string; status: string; reference?: string | null; amount: { value: number | string } }>(
      'GET',
      `/payments/${encodeURIComponent(monimeRef)}`,
    );
    return {
      monimeRef,
      reference: p.reference ?? null,
      status: mapPaymentStatus(p.status),
      amount: BigInt(p.amount.value),
    };
  }

  async transfer(input: TransferInput): Promise<TransferResult> {
    // TODO(monime): endpoint for moving money between two of our financial accounts
    //   (internal transfer?) and its body. Payouts (POST /payouts) are for external
    //   destinations (momo/bank/wallet), so they may not fit here.
    const result = await this.request<{ id: string; status?: string }>('POST', '/TODO-monime-internal-transfer-endpoint', {
      idempotencyKey: input.idempotencyKey,
      body: {
        amount: toAmount(input.amount),
        sourceFinancialAccountId: input.fromAccount,
        destinationFinancialAccountId: input.toAccount,
        description: input.description,
        metadata: { paymentId: input.idempotencyKey },
      },
    });
    return { transferId: result.id, status: result.status === 'completed' ? 'COMPLETED' : 'PENDING' };
  }

  // ---------------------------------------------------------------------------

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    if (method === 'POST' && (!opts.idempotencyKey || opts.idempotencyKey.length > IDEMPOTENCY_KEY_MAX)) {
      throw new MonimeError('REJECTED', `Idempotency-Key required, ≤ ${IDEMPOTENCY_KEY_MAX} chars`);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.accessToken}`,
      'Monime-Space-Id': this.cfg.spaceId,
      'Monime-Version': this.cfg.apiVersion,
      Accept: 'application/json',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
    };
    const url = this.cfg.baseUrl.replace(/\/+$/, '') + path;
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const maxAttempts = this.cfg.maxAttempts ?? 3;

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.send<T>(method, url, headers, body);
      } catch (err) {
        const retryable = err instanceof MonimeError && err.code === 'UNAVAILABLE';
        if (!retryable || attempt >= maxAttempts) throw err;
        this.logger.warn(`Monime ${method} ${path} failed (${err.message}); retry ${attempt}/${maxAttempts - 1}`);
        await sleep(250 * 2 ** (attempt - 1) + Math.random() * 250);
      }
    }
  }

  private async send<T>(method: string, url: string, headers: Record<string, string>, body?: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15_000) });
    } catch (err) {
      throw new MonimeError('UNAVAILABLE', `Monime request failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    let payload: { success?: boolean; result?: T; error?: { message?: string; code?: string } } | null = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (res.ok && payload?.success && payload.result !== undefined) return payload.result;

    const message = payload?.error?.message ?? `Monime responded with HTTP ${res.status}`;
    if (res.status === 404) throw new MonimeError('NOT_FOUND', message, 404);
    if (res.status === 429 || res.status >= 500) throw new MonimeError('UNAVAILABLE', message, res.status);
    if (res.status >= 400) throw new MonimeError('REJECTED', message, res.status);
    throw new MonimeError('BAD_RESPONSE', message, res.status);
  }
}

function toAmount(value: bigint): { currency: 'SLE'; value: number } {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new MonimeError('REJECTED', `Amount ${value} is too large`);
  return { currency: 'SLE', value: n };
}

function sanitizeMetadata(m: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(m)
      .slice(0, METADATA_MAX_KEYS)
      .map(([k, v]) => [k, String(v).slice(0, METADATA_VALUE_MAX)]),
  );
}

function mapPaymentStatus(raw: string): MonimePaymentView['status'] {
  // TODO(monime): confirm the full Payment status vocabulary.
  switch (raw) {
    case 'completed':
      return 'COMPLETED';
    case 'failed':
    case 'cancelled':
      return 'FAILED';
    case 'expired':
      return 'EXPIRED';
    default:
      return 'PENDING';
  }
}
