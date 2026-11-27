import { Logger } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { reportedMsisdn } from '../../../shared/domain/phone';
import {
  type BankView,
  type CheckoutSessionView,
  type CreateCheckoutSessionInput,
  type CreateFinancialAccountInput,
  type CreateInternalTransferInput,
  type CreatePaymentCodeInput,
  type CreatePayoutInput,
  type CreateWebhookInput,
  type FinancialAccountView,
  type InternalTransferView,
  type MonimeClient,
  type MonimePage,
  type MonimePaymentRecord,
  MonimeError,
  type PaymentCodeView,
  type PayoutView,
} from './monime.port';

export interface HttpMonimeConfig {
  /** Includes the version path, e.g. https://api.monime.io/v1 */
  baseUrl: string;
  accessToken: string;
  spaceId: string;
  apiVersion: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
}

const IDEMPOTENCY_KEY_MAX = 64;
const METADATA_MAX_KEYS = 64;
const METADATA_VALUE_MAX = 100;

// Wire shapes (caph.2025-08-23), only the fields we read.
interface WireAmount {
  currency: string;
  value: number | string;
}
interface WireFee {
  code: string;
  amount: WireAmount;
}
interface WirePaymentCode {
  id: string;
  status: PaymentCodeView['status'];
  ussdCode?: string | null;
  expireTime?: string | null;
  reference?: string | null;
  amount: WireAmount;
}
interface WireCheckoutSession {
  id: string;
  status: CheckoutSessionView['status'];
  redirectUrl?: string | null;
  orderNumber?: string | null;
  expireTime?: string | null;
}
interface WireFinancialAccount {
  id: string;
  uvan?: string | null;
  name: string;
  currency: string;
  reference?: string | null;
  balance?: { available: WireAmount } | null;
}
interface WireInternalTransfer {
  id: string;
  status: InternalTransferView['status'];
  amount: WireAmount;
  failureDetail?: { code: string; message?: string | null } | null;
}
interface WirePayout {
  id: string;
  status: PayoutView['status'];
  amount: WireAmount;
  fees?: WireFee[] | null;
  failureDetail?: { code: string; message?: string | null } | null;
}
interface WirePayment {
  id: string;
  status: MonimePaymentRecord['status'];
  amount: WireAmount;
  financialAccountId?: string | null;
  reference?: string | null;
  metadata?: Record<string, unknown> | null;
  fees?: WireFee[] | null;
  channel?: { type?: string; phoneNumber?: string } | null;
  orderNumber?: string | null;
  ownershipGraph?: { owner?: { id?: string; metadata?: Record<string, unknown> | null } | null } | null;
  createTime: string;
  updateTime?: string | null;
}
interface WireBank {
  providerId: string;
  name: string;
  status?: { active?: boolean };
  featureSet?: { payout?: { canPayTo?: boolean } };
}

/**
 * Monime REST adapter (API caph.2025-08-23, https://api.monime.io/v1).
 * Headers: Authorization Bearer, Monime-Space-Id, Monime-Version, Idempotency-Key
 * (≤ 64 chars, required on creates). Responses: { success, messages, result }.
 * Network errors, 429 and 5xx are retried with the same idempotency key.
 */
export class HttpMonimeClient implements MonimeClient {
  private readonly logger = new Logger(HttpMonimeClient.name);

  constructor(
    private readonly cfg: HttpMonimeConfig,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  // ── Payment codes ──────────────────────────────────────────────────────────

  async createPaymentCode(input: CreatePaymentCodeInput): Promise<PaymentCodeView> {
    const pc = await this.post<WirePaymentCode>('/payment-codes', input.idempotencyKey, {
      mode: 'one_time',
      name: input.name.slice(0, 64),
      amount: toWire(input.amount),
      duration: `${input.durationMinutes}m`,
      reference: input.reference,
      // TODO(monime): confirm the MSISDN format expected here (+232… vs 232…).
      ...(input.authorizedPhoneNumber ? { authorizedPhoneNumber: input.authorizedPhoneNumber } : {}),
      financialAccountId: input.financialAccountId,
      metadata: sanitizeMetadata(input.metadata),
    });
    return toPaymentCode(pc);
  }

  async getPaymentCode(id: string): Promise<PaymentCodeView> {
    return toPaymentCode(await this.get<WirePaymentCode>(`/payment-codes/${enc(id)}`));
  }

  // ── Checkout sessions ──────────────────────────────────────────────────────

  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionView> {
    const cs = await this.post<WireCheckoutSession>('/checkout-sessions', input.idempotencyKey, {
      name: input.name.slice(0, 150),
      ...(input.description ? { description: input.description.slice(0, 1000) } : {}),
      reference: input.reference,
      financialAccountId: input.financialAccountId,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      lineItems: [{ type: 'custom', name: input.lineItemName.slice(0, 100), price: toWire(input.amount), quantity: 1, reference: input.reference.slice(0, 100) }],
      paymentOptions: checkoutPaymentOptions(input.method),
      ...(input.primaryColor ? { brandingOptions: { primaryColor: input.primaryColor } } : {}),
      metadata: sanitizeMetadata(input.metadata),
    });
    if (!cs.redirectUrl) throw new MonimeError('BAD_RESPONSE', `Checkout session ${cs.id} has no redirectUrl`);
    return { id: cs.id, status: cs.status, redirectUrl: cs.redirectUrl, orderNumber: cs.orderNumber ?? null, expireTime: cs.expireTime ?? null };
  }

  // ── Payments ───────────────────────────────────────────────────────────────

  async listPayments(q: { financialAccountId: string; after?: string | null; limit?: number }): Promise<MonimePage<MonimePaymentRecord>> {
    const qs = new URLSearchParams({ financialAccountId: q.financialAccountId, limit: String(q.limit ?? 50) });
    if (q.after) qs.set('after', q.after);
    const page = await this.request<WirePayment[]>('GET', `/payments?${qs.toString()}`);
    return { items: (page.result ?? []).map(toPaymentRecord), next: page.next };
  }

  async getPayment(id: string): Promise<MonimePaymentRecord> {
    return toPaymentRecord(await this.get<WirePayment>(`/payments/${enc(id)}`));
  }

  // ── Financial accounts ─────────────────────────────────────────────────────

  async createFinancialAccount(input: CreateFinancialAccountInput): Promise<FinancialAccountView> {
    const fa = await this.post<WireFinancialAccount>('/financial-accounts', input.idempotencyKey, {
      name: input.name.slice(0, 100),
      currency: input.currency,
      reference: input.reference,
      ...(input.description ? { description: input.description.slice(0, 150) } : {}),
      ...(input.metadata ? { metadata: sanitizeMetadata(input.metadata) } : {}),
    });
    return toAccount(fa);
  }

  async getFinancialAccount(id: string, opts: { withBalance?: boolean } = {}): Promise<FinancialAccountView> {
    const qs = opts.withBalance ? '?withBalance=true' : '';
    return toAccount(await this.get<WireFinancialAccount>(`/financial-accounts/${enc(id)}${qs}`));
  }

  async findFinancialAccountByReference(reference: string): Promise<FinancialAccountView | null> {
    const list = await this.get<WireFinancialAccount[]>(`/financial-accounts?reference=${enc(reference)}&limit=1`);
    const fa = list.find((a) => a.reference === reference);
    return fa ? toAccount(fa) : null;
  }

  // ── Internal transfers ─────────────────────────────────────────────────────

  async createInternalTransfer(input: CreateInternalTransferInput): Promise<InternalTransferView> {
    const t = await this.post<WireInternalTransfer>('/internal-transfers', input.idempotencyKey, {
      amount: toWire(input.amount),
      sourceFinancialAccount: { id: input.sourceAccountId },
      destinationFinancialAccount: { id: input.destinationAccountId },
      metadata: sanitizeMetadata(input.metadata),
    });
    return toTransfer(t);
  }

  async getInternalTransfer(id: string): Promise<InternalTransferView> {
    return toTransfer(await this.get<WireInternalTransfer>(`/internal-transfers/${enc(id)}`));
  }

  // ── Payouts ────────────────────────────────────────────────────────────────

  async createPayout(input: CreatePayoutInput): Promise<PayoutView> {
    const p = await this.post<WirePayout>('/payouts', input.idempotencyKey, {
      amount: toWire(input.amount),
      source: { financialAccountId: input.sourceAccountId },
      destination: input.destination,
      metadata: sanitizeMetadata(input.metadata),
    });
    return toPayout(p);
  }

  async getPayout(id: string): Promise<PayoutView> {
    return toPayout(await this.get<WirePayout>(`/payouts/${enc(id)}`));
  }

  async listBanks(country: string): Promise<BankView[]> {
    const banks = await this.get<WireBank[]>(`/banks?country=${enc(country)}&limit=50`);
    return banks.map((b) => ({
      providerId: b.providerId,
      name: b.name,
      active: b.status?.active ?? false,
      canPayTo: b.featureSet?.payout?.canPayTo ?? false,
    }));
  }

  // ── Webhooks ───────────────────────────────────────────────────────────────

  async createWebhook(input: CreateWebhookInput): Promise<{ id: string }> {
    const w = await this.post<{ id: string }>('/webhooks', input.idempotencyKey, {
      name: input.name,
      url: input.url,
      enabled: true,
      apiRelease: 'caph',
      events: input.events,
      verificationMethod: { type: 'HS256', secret: input.secret },
    });
    return { id: w.id };
  }

  // ── Transport ──────────────────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    return (await this.request<T>('GET', path)).result;
  }

  private post<T>(path: string, idempotencyKey: string, body: unknown): Promise<T> {
    if (!idempotencyKey || idempotencyKey.length > IDEMPOTENCY_KEY_MAX) {
      throw new MonimeError('REJECTED', `Idempotency-Key required, ≤ ${IDEMPOTENCY_KEY_MAX} chars`);
    }
    return this.request<T>('POST', path, body, idempotencyKey).then((r) => r.result);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<{ result: T; next: string | null }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.accessToken}`,
      'Monime-Space-Id': this.cfg.spaceId,
      'Monime-Version': this.cfg.apiVersion,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    };
    const url = this.cfg.baseUrl.replace(/\/+$/, '') + path;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const maxAttempts = this.cfg.maxAttempts ?? 3;
    const base = this.cfg.retryBaseDelayMs ?? 250;

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.send<T>(method, url, headers, payload);
      } catch (err) {
        if (!(err instanceof MonimeError && err.code === 'UNAVAILABLE') || attempt >= maxAttempts) throw err;
        this.logger.warn(`Monime ${method} ${path} failed (${err.message}); retry ${attempt}/${maxAttempts - 1}`);
        await sleep(base * 2 ** (attempt - 1) + Math.random() * base);
      }
    }
  }

  private async send<T>(method: string, url: string, headers: Record<string, string>, body?: string): Promise<{ result: T; next: string | null }> {
    let res: Response;
    try {
      res = await this.fetchFn(url, { method, headers, body, signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15_000) });
    } catch (err) {
      throw new MonimeError('UNAVAILABLE', `Monime request failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    let json: { success?: boolean; result?: T; pagination?: { next?: string | null }; error?: { message?: string; code?: string } } | null = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.ok && json?.success && json.result !== undefined) return { result: json.result, next: json.pagination?.next ?? null };

    const message = json?.error?.message ?? `Monime responded with HTTP ${res.status}`;
    if (res.status === 404) throw new MonimeError('NOT_FOUND', message, 404);
    if (res.status === 429 || res.status >= 500 || res.status === 0) throw new MonimeError('UNAVAILABLE', message, res.status);
    if (res.status >= 400) throw new MonimeError('REJECTED', message, res.status);
    throw new MonimeError('BAD_RESPONSE', message, res.status);
  }
}

// ── Mapping ──────────────────────────────────────────────────────────────────

const enc = encodeURIComponent;

/** Only the chosen method stays on; bank and wallet are always off. */
export function checkoutPaymentOptions(method: CreateCheckoutSessionInput['method']) {
  return {
    card: { disable: method !== 'card' },
    momo: { disable: method !== 'momo' },
    bank: { disable: true },
    wallet: { disable: true },
  };
}

function toWire(value: bigint): { currency: 'SLE'; value: number } {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new MonimeError('REJECTED', `Invalid amount ${value}`);
  return { currency: 'SLE', value: n };
}

function fromWire(a: WireAmount | null | undefined): bigint {
  return a ? BigInt(a.value) : 0n;
}

function sumFees(fees: WireFee[] | null | undefined): bigint {
  return (fees ?? []).filter((f) => f.amount?.currency === 'SLE').reduce((s, f) => s + BigInt(f.amount.value), 0n);
}

function sanitizeMetadata(m: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(m)
      .slice(0, METADATA_MAX_KEYS)
      .map(([k, v]) => [k, String(v).slice(0, METADATA_VALUE_MAX)]),
  );
}

function toPaymentCode(pc: WirePaymentCode): PaymentCodeView {
  return {
    id: pc.id,
    status: pc.status,
    ussdCode: pc.ussdCode ?? null,
    expireTime: pc.expireTime ?? null,
    reference: pc.reference ?? null,
    amount: fromWire(pc.amount),
  };
}

function toAccount(fa: WireFinancialAccount): FinancialAccountView {
  return {
    id: fa.id,
    uvan: fa.uvan ?? null,
    name: fa.name,
    currency: fa.currency,
    reference: fa.reference ?? null,
    available: fa.balance?.available ? fromWire(fa.balance.available) : null,
  };
}

function toTransfer(t: WireInternalTransfer): InternalTransferView {
  return {
    id: t.id,
    status: t.status,
    amount: fromWire(t.amount),
    failure: t.failureDetail ? { code: t.failureDetail.code, message: t.failureDetail.message ?? null } : null,
  };
}

function stringRecord(v: Record<string, unknown> | null | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(v ?? {}).filter(([, x]) => typeof x === 'string' || typeof x === 'number').map(([k, x]) => [k, String(x)]));
}

function toPaymentRecord(p: WirePayment): MonimePaymentRecord {
  const owner = p.ownershipGraph?.owner ?? null;
  return {
    id: p.id,
    status: p.status,
    currency: p.amount.currency,
    amount: BigInt(p.amount.value),
    financialAccountId: p.financialAccountId ?? null,
    reference: p.reference ?? null,
    metadata: { ...stringRecord(owner?.metadata), ...stringRecord(p.metadata) },
    ownerId: owner?.id ?? null,
    fees: (p.fees ?? []).filter((f) => f.amount?.currency === p.amount.currency).reduce((s, f) => s + BigInt(f.amount.value), 0n),
    payerPhone: reportedMsisdn(p.channel?.phoneNumber),
    orderNumber: p.orderNumber ?? null,
    channelType: p.channel?.type ?? null,
    createTime: new Date(p.createTime),
    updateTime: p.updateTime ? new Date(p.updateTime) : null,
  };
}

function toPayout(p: WirePayout): PayoutView {
  return {
    id: p.id,
    status: p.status,
    amount: fromWire(p.amount),
    fees: sumFees(p.fees),
    failure: p.failureDetail ? { code: p.failureDetail.code, message: p.failureDetail.message ?? null } : null,
  };
}
