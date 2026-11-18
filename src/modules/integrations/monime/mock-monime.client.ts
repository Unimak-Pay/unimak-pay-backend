import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../shared/infrastructure/prisma.service';
import {
  type BankView,
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

type Kind = 'PAYMENT_CODE' | 'PAYMENT' | 'ACCOUNT' | 'TRANSFER' | 'PAYOUT' | 'WEBHOOK';

/** Same ids as the real ones from GET /v1/banks?country=SL (enum in the spec). */
const MOCK_BANKS: BankView[] = [
  { providerId: 'slb001', name: 'Sierra Leone Commercial Bank (mock)', active: true, canPayTo: true },
  { providerId: 'slb004', name: 'Mock Bank 004', active: true, canPayTo: true },
  { providerId: 'slb007', name: 'Mock Bank 007', active: true, canPayTo: true },
];

/**
 * Stand-in for Monime (MONIME_MODE=mock), persisted in MockMonimeRecord so it
 * survives serverless invocations. Creates are idempotent on the idempotency
 * key. Nothing completes by itself: payment codes, transfers and payouts stay
 * pending until POST /dev/monime/simulate-webhook moves them on.
 */
export class MockMonimeClient implements MonimeClient {
  constructor(private readonly prisma: PrismaService) {}

  // ── Payment codes ──────────────────────────────────────────────────────────

  async createPaymentCode(input: CreatePaymentCodeInput): Promise<PaymentCodeView> {
    const id = `pmc-mock-${input.reference}`.slice(0, 64);
    const row = await this.create(id, 'PAYMENT_CODE', 'pending', input.amount, {
      idempotencyKey: input.idempotencyKey,
      name: input.name,
      reference: input.reference,
      financialAccountId: input.financialAccountId,
      authorizedPhoneNumber: input.authorizedPhoneNumber ?? null,
      expireTime: new Date(Date.now() + input.durationMinutes * 60_000).toISOString(),
      ussdCode: `*715*1*${Math.floor(1e9 + Math.random() * 9e9)}#`,
      metadata: input.metadata,
    });
    return this.toPaymentCode(row);
  }

  async getPaymentCode(id: string): Promise<PaymentCodeView> {
    return this.toPaymentCode(await this.find(id, 'PAYMENT_CODE'));
  }

  // ── Payments ───────────────────────────────────────────────────────────────

  /** Newest first, like a typical Monime listing; cursor = offset. */
  async listPayments(q: { financialAccountId: string; after?: string | null; limit?: number }): Promise<MonimePage<MonimePaymentRecord>> {
    const limit = q.limit ?? 50;
    const offset = q.after ? Number(q.after) : 0;
    const rows = await this.prisma.mockMonimeRecord.findMany({
      where: { kind: 'PAYMENT', data: { path: ['financialAccountId'], equals: q.financialAccountId } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit + 1,
    });
    return { items: rows.slice(0, limit).map((r) => this.toPaymentRecord(r)), next: rows.length > limit ? String(offset + limit) : null };
  }

  async getPayment(id: string): Promise<MonimePaymentRecord> {
    return this.toPaymentRecord(await this.find(id, 'PAYMENT'));
  }

  /** Dev helper: what Monime records when a collection completes. */
  async recordPayment(p: { id: string; amount: bigint; financialAccountId: string | null; reference: string | null; metadata: Record<string, string>; ownerId: string | null; fees: bigint; payerPhone: string | null; createTime?: Date }): Promise<void> {
    const at = p.createTime ?? new Date();
    await this.prisma.mockMonimeRecord.upsert({
      where: { id: p.id },
      create: {
        id: p.id, kind: 'PAYMENT', status: 'completed', amount: p.amount, createdAt: at,
        data: { financialAccountId: p.financialAccountId, reference: p.reference, metadata: p.metadata, ownerId: p.ownerId, fees: p.fees.toString(), payerPhone: p.payerPhone, createTime: at.toISOString() },
      },
      update: {},
    });
  }

  // ── Financial accounts ─────────────────────────────────────────────────────

  async createFinancialAccount(input: CreateFinancialAccountInput): Promise<FinancialAccountView> {
    const existing = await this.findFinancialAccountByReference(input.reference);
    if (existing) {
      throw new MonimeError('REJECTED', `A financial account with reference ${input.reference} already exists`, 409);
    }
    const id = `fac-mock-${input.reference.replace(/[^A-Za-z0-9-]/g, '-')}`.slice(0, 64);
    const row = await this.create(id, 'ACCOUNT', 'active', 0n, {
      name: input.name,
      currency: input.currency,
      reference: input.reference,
      uvan: String(Math.floor(1e11 + Math.random() * 9e11)),
    });
    return this.toAccount(row, null);
  }

  async getFinancialAccount(id: string, opts: { withBalance?: boolean } = {}): Promise<FinancialAccountView> {
    const row = await this.prisma.mockMonimeRecord.findUnique({ where: { id } });
    // Seeded fee types point at accounts that were never "created" in the mock.
    const data = row ? (row.data as Record<string, unknown>) : { name: id, currency: 'SLE', reference: null, uvan: null };
    return this.toAccount({ id, data }, opts.withBalance ? await this.balanceOf(id) : null);
  }

  async findFinancialAccountByReference(reference: string): Promise<FinancialAccountView | null> {
    const row = await this.prisma.mockMonimeRecord.findFirst({
      where: { kind: 'ACCOUNT', data: { path: ['reference'], equals: reference } },
    });
    return row ? this.toAccount(row, null) : null;
  }

  // ── Internal transfers ─────────────────────────────────────────────────────

  async createInternalTransfer(input: CreateInternalTransferInput): Promise<InternalTransferView> {
    const id = `trn-mock-${input.idempotencyKey}`.slice(0, 64);
    const row = await this.create(id, 'TRANSFER', 'pending', input.amount, {
      sourceFinancialAccountId: input.sourceAccountId,
      destinationFinancialAccountId: input.destinationAccountId,
      metadata: input.metadata,
    });
    return this.toTransfer(row);
  }

  async getInternalTransfer(id: string): Promise<InternalTransferView> {
    return this.toTransfer(await this.find(id, 'TRANSFER'));
  }

  // ── Payouts ────────────────────────────────────────────────────────────────

  async createPayout(input: CreatePayoutInput): Promise<PayoutView> {
    const id = `pyt-mock-${input.idempotencyKey}`.slice(0, 64);
    const row = await this.create(id, 'PAYOUT', 'pending', input.amount, {
      sourceFinancialAccountId: input.sourceAccountId,
      destination: input.destination,
      metadata: input.metadata,
    });
    return this.toPayout(row);
  }

  async getPayout(id: string): Promise<PayoutView> {
    return this.toPayout(await this.find(id, 'PAYOUT'));
  }

  async listBanks(country: string): Promise<BankView[]> {
    return country.toUpperCase() === 'SL' ? MOCK_BANKS : [];
  }

  // ── Webhooks ───────────────────────────────────────────────────────────────

  async createWebhook(input: CreateWebhookInput): Promise<{ id: string }> {
    const id = `whk-mock-${input.idempotencyKey}`.slice(0, 64);
    await this.create(id, 'WEBHOOK', 'enabled', 0n, { name: input.name, url: input.url, events: input.events });
    return { id };
  }

  // ── Dev helpers (used by /dev/monime/simulate-webhook) ─────────────────────

  async setStatus(id: string, status: string, extra: Record<string, unknown> = {}): Promise<{ amount: bigint; data: Record<string, unknown> }> {
    const row = await this.prisma.mockMonimeRecord.findUnique({ where: { id } });
    if (!row) throw new MonimeError('NOT_FOUND', `Mock object ${id} not found`, 404);
    const data = { ...(row.data as Record<string, unknown>), ...extra };
    await this.prisma.mockMonimeRecord.update({ where: { id }, data: { status, data: data as Prisma.InputJsonValue } });
    return { amount: row.amount, data };
  }

  /** completed collections in, transfers in/out, payouts out (pending ones count as spent). */
  async balanceOf(accountId: string): Promise<bigint> {
    const rows = await this.prisma.mockMonimeRecord.findMany({ where: { kind: { in: ['PAYMENT', 'TRANSFER', 'PAYOUT'] } } });
    let balance = 0n;
    for (const r of rows) {
      const d = r.data as Record<string, unknown>;
      if (r.kind === 'PAYMENT' && d['financialAccountId'] === accountId) balance += r.amount;
      if (r.kind === 'TRANSFER' && r.status !== 'failed') {
        if (d['sourceFinancialAccountId'] === accountId) balance -= r.amount;
        if (r.status === 'completed' && d['destinationFinancialAccountId'] === accountId) balance += r.amount;
      }
      if (r.kind === 'PAYOUT' && r.status !== 'failed' && d['sourceFinancialAccountId'] === accountId) balance -= r.amount;
    }
    return balance;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async create(id: string, kind: Kind, status: string, amount: bigint, data: Record<string, unknown>) {
    return this.prisma.mockMonimeRecord.upsert({
      where: { id },
      create: { id, kind, status, amount, data: { ...data, nonce: randomUUID() } as Prisma.InputJsonValue },
      update: {}, // idempotent replay returns the original
    });
  }

  private async find(id: string, kind: Kind) {
    const row = await this.prisma.mockMonimeRecord.findUnique({ where: { id } });
    if (!row || row.kind !== kind) throw new MonimeError('NOT_FOUND', `${kind} ${id} not found`, 404);
    return row;
  }

  private toPaymentRecord(r: { id: string; status: string; amount: bigint; data: unknown; createdAt: Date }): MonimePaymentRecord {
    const d = r.data as Record<string, unknown>;
    return {
      id: r.id,
      status: r.status as MonimePaymentRecord['status'],
      currency: 'SLE',
      amount: r.amount,
      financialAccountId: (d['financialAccountId'] as string | null) ?? null,
      reference: (d['reference'] as string | null) ?? null,
      metadata: (d['metadata'] as Record<string, string>) ?? {},
      ownerId: (d['ownerId'] as string | null) ?? null,
      fees: BigInt((d['fees'] as string | undefined) ?? '0'),
      payerPhone: (d['payerPhone'] as string | null) ?? null,
      createTime: new Date((d['createTime'] as string | undefined) ?? r.createdAt),
      updateTime: null,
    };
  }

  private toPaymentCode(r: { id: string; status: string; amount: bigint; data: unknown }): PaymentCodeView {
    const d = r.data as Record<string, string | null>;
    return {
      id: r.id,
      status: r.status as PaymentCodeView['status'],
      ussdCode: d['ussdCode'] ?? null,
      expireTime: d['expireTime'] ?? null,
      reference: d['reference'] ?? null,
      amount: r.amount,
    };
  }

  private toAccount(r: { id: string; data: unknown }, available: bigint | null): FinancialAccountView {
    const d = r.data as Record<string, string | null>;
    return { id: r.id, uvan: d['uvan'] ?? null, name: d['name'] ?? r.id, currency: d['currency'] ?? 'SLE', reference: d['reference'] ?? null, available };
  }

  private toTransfer(r: { id: string; status: string; amount: bigint; data: unknown }): InternalTransferView {
    const f = (r.data as Record<string, unknown>)['failureDetail'] as { code: string; message?: string } | undefined;
    return { id: r.id, status: r.status as InternalTransferView['status'], amount: r.amount, failure: f ? { code: f.code, message: f.message ?? null } : null };
  }

  private toPayout(r: { id: string; status: string; amount: bigint; data: unknown }): PayoutView {
    const d = r.data as Record<string, unknown>;
    const f = d['failureDetail'] as { code: string; message?: string } | undefined;
    return {
      id: r.id,
      status: r.status as PayoutView['status'],
      amount: r.amount,
      fees: BigInt((d['fees'] as string | undefined) ?? '0'),
      failure: f ? { code: f.code, message: f.message ?? null } : null,
    };
  }
}
