import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DomainError } from '../../../shared/domain/errors';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { AuditService } from '../../audit/audit.service';
import type { AdminPrincipal } from '../../auth/application/admin-principal';
import { MONIME_CLIENT, type MonimeClient } from '../../integrations/monime/monime.port';
import { OutboxDispatcher } from '../../outbox/application/outbox-dispatcher';
import { ReconcilePaymentUseCase } from '../../payments/application/reconcile-payment.use-case';
import { NightlyReconciliationService } from '../../reconciliation/application/nightly-reconciliation.service';
import { CommissionTransferService } from '../../treasury/application/commission-transfer.service';
import { MonimeWebhookReceiver } from '../../webhooks/application/monime-webhook.receiver';
import { normalizePublicRef } from '../../payments/domain/payment-ref';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

function page<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.id : null };
}

const cursorArgs = (limit: number, cursor?: string) => ({ take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
const HOUR = 60 * 60_000;

/** Read models and operator actions behind /v1/admin. Every write is audited. */
@Injectable()
export class AdminOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly reconcile: ReconcilePaymentUseCase,
    private readonly commission: CommissionTransferService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly receiver: MonimeWebhookReceiver,
    private readonly reconciliation: NightlyReconciliationService,
    @Inject(MONIME_CLIENT) private readonly monime: MonimeClient,
  ) {}

  // ── Payments ───────────────────────────────────────────────────────────────

  /** Heads of department only see payments of payers in their departments. */
  private paymentScope(admin: AdminPrincipal): Prisma.PaymentWhereInput {
    return admin.departmentScoped ? { obligation: { payer: { department: { in: [...admin.departments] } } } } : {};
  }

  async listPayments(admin: AdminPrincipal, q: { limit: number; cursor?: string; status?: string; channel?: string; feeType?: string; payerRef?: string; ref?: string; from?: string; to?: string }) {
    const where: Prisma.PaymentWhereInput = {
      AND: [
        this.paymentScope(admin),
        q.status ? { status: q.status as never } : {},
        q.channel ? { channel: q.channel as never } : {},
        q.feeType ? { obligation: { fee: { feeType: { code: q.feeType } } } } : {},
        q.payerRef ? { obligation: { payer: { ref: q.payerRef } } } : {},
        q.ref ? refFilter(q.ref) : {},
        q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } } : {},
      ],
    };
    const rows = await this.prisma.payment.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { obligation: { include: { payer: true, fee: { include: { feeType: true } } } }, receipt: true },
      ...cursorArgs(q.limit, q.cursor),
    });
    return page(rows.map(presentPayment), q.limit);
  }

  async getPayment(admin: AdminPrincipal, id: string) {
    const p = await this.prisma.payment.findFirst({
      where: { id, ...this.paymentScope(admin) },
      include: { obligation: { include: { payer: true, fee: { include: { feeType: true } } } }, receipt: true, ledgerEntry: true },
    });
    if (!p) throw new DomainError('NOT_FOUND', 'Payment not found');
    const transfer = await this.prisma.transfer.findUnique({ where: { paymentId: id } });
    return { ...presentPayment(p), ledgerEntry: p.ledgerEntry, commissionTransfer: transfer };
  }

  async reconcilePayment(admin: AdminPrincipal, id: string) {
    const before = await this.getPayment(admin, id);
    const after = await this.reconcile.execute(id);
    if (after.status !== before.status) {
      await this.audit.record({ actorId: admin.id, action: 'payment.reconcile', entity: 'Payment', entityId: id, before: { status: before.status }, after: { status: after.status } });
    }
    return { paymentId: id, before: before.status, after: after.status };
  }

  // ── Financial accounts ─────────────────────────────────────────────────────

  async listAccounts() {
    const rows = await this.prisma.financialAccount.findMany({ include: { feeType: true }, orderBy: { reference: 'asc' } });
    const reserved = await this.prisma.payout.groupBy({ by: ['financialAccountId'], where: { status: 'REQUESTED' }, _sum: { amount: true } });
    const byId = new Map(reserved.map((r) => [r.financialAccountId, r._sum.amount ?? 0n]));
    return rows.map((a) => ({ ...a, feeTypeCode: a.feeType?.code ?? null, feeType: undefined, unsubmittedPayouts: byId.get(a.id) ?? 0n }));
  }

  async refreshBalance(id: string) {
    const a = await this.prisma.financialAccount.findUnique({ where: { id } });
    if (!a) throw new DomainError('NOT_FOUND', 'Financial account not found');
    const remote = await this.monime.getFinancialAccount(a.monimeId, { withBalance: true });
    return this.prisma.financialAccount.update({ where: { id }, data: { availableBalance: remote.available, balanceUpdatedAt: new Date() } });
  }

  // ── Payouts & transfers ────────────────────────────────────────────────────

  async listPayouts(q: { limit: number; cursor?: string; status?: string }) {
    const rows = await this.prisma.payout.findMany({
      where: q.status ? { status: q.status as never } : {},
      include: { financialAccount: { select: { reference: true, monimeId: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(q.limit, q.cursor),
    });
    return page(rows, q.limit);
  }

  async getPayout(id: string) {
    const p = await this.prisma.payout.findUnique({ where: { id }, include: { financialAccount: true } });
    if (!p) throw new DomainError('NOT_FOUND', 'Payout not found');
    return p;
  }

  async listTransfers(q: { limit: number; cursor?: string; status?: string }) {
    const rows = await this.prisma.transfer.findMany({
      where: q.status ? { status: q.status as never } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(q.limit, q.cursor),
    });
    return page(rows, q.limit);
  }

  /** FAILED commission transfer → new attempt (new Idempotency-Key) and send now. */
  async retryTransfer(admin: AdminPrincipal, id: string) {
    const before = await this.prisma.transfer.findUnique({ where: { id } });
    if (!before) throw new DomainError('NOT_FOUND', 'Transfer not found');
    if (before.status !== 'FAILED' || !before.paymentId) throw new DomainError('INVALID_STATE', `Only FAILED commission transfers can be retried (is ${before.status})`);
    const reset = await this.prisma.$transaction(async (tx) => {
      const r = await tx.transfer.update({
        where: { id },
        data: { status: 'PENDING', attempt: { increment: 1 }, monimeTransferId: null, failureCode: null, failureMessage: null },
      });
      await this.audit.record({ actorId: admin.id, action: 'transfer.retry', entity: 'Transfer', entityId: id, before, after: r }, tx);
      return r;
    });
    await this.commission.send({ paymentId: reset.paymentId!, fromAccount: reset.sourceAccount, amount: reset.amount.toString() });
    return this.prisma.transfer.findUniqueOrThrow({ where: { id } });
  }

  // ── Outbox ─────────────────────────────────────────────────────────────────

  async listOutbox(q: { limit: number; cursor?: string; status?: string }) {
    const rows = await this.prisma.outboxMessage.findMany({
      where: q.status ? { status: q.status as never } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(q.limit, q.cursor),
    });
    return page(rows, q.limit);
  }

  async retryOutbox(admin: AdminPrincipal, id: string) {
    const before = await this.prisma.outboxMessage.findUnique({ where: { id } });
    if (!before) throw new DomainError('NOT_FOUND', 'Outbox message not found');
    if (before.status !== 'DEAD') throw new DomainError('INVALID_STATE', `Only DEAD messages can be retried (is ${before.status})`);
    await this.prisma.$transaction(async (tx) => {
      const after = await tx.outboxMessage.update({ where: { id }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lockedUntil: null } });
      await this.audit.record({ actorId: admin.id, action: 'outbox.retry', entity: 'OutboxMessage', entityId: id, before, after }, tx);
    });
    await this.dispatcher.dispatchKeys([before.dedupeKey]);
    return this.prisma.outboxMessage.findUniqueOrThrow({ where: { id } });
  }

  // ── Reconciliation ─────────────────────────────────────────────────────────

  /** Everything that needs a human: one call for the reconciliation screen. */
  async reconciliationSummary(now = new Date()) {
    const hourAgo = new Date(now.getTime() - HOUR);
    const [openItems, webhookEvents, failedTransfers, stuckTransfers, stuckPayouts, failedPayouts, deadOutbox, staleOpenPayments] = await Promise.all([
      this.prisma.reconciliationItem.findMany({ where: { status: 'OPEN' }, orderBy: { createdAt: 'desc' }, take: 200 }),
      this.prisma.webhookEvent.findMany({ where: { status: { in: ['UNMATCHED', 'FAILED'] }, resolvedAt: null }, orderBy: { receivedAt: 'desc' }, take: 100 }),
      this.prisma.transfer.findMany({ where: { status: 'FAILED' }, orderBy: { updatedAt: 'desc' }, take: 100 }),
      this.prisma.transfer.findMany({ where: { status: { in: ['PENDING', 'SUBMITTED'] }, createdAt: { lt: hourAgo } }, take: 100 }),
      this.prisma.payout.findMany({ where: { status: { in: ['REQUESTED', 'SUBMITTED', 'PROCESSING'] }, createdAt: { lt: hourAgo } }, take: 100 }),
      this.prisma.payout.findMany({ where: { status: 'FAILED', updatedAt: { gt: new Date(now.getTime() - 7 * 24 * HOUR) } }, take: 100 }),
      this.prisma.outboxMessage.findMany({ where: { status: 'DEAD' }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.prisma.payment.findMany({ where: { status: { in: ['INITIATED', 'PENDING'] }, expiresAt: { lt: now } }, take: 100 }),
    ]);
    return {
      lastRun: await this.prisma.reconciliationRun.findFirst({ orderBy: { startedAt: 'desc' } }),
      counts: {
        openItems: openItems.length,
        webhookEvents: webhookEvents.length, failedTransfers: failedTransfers.length, stuckTransfers: stuckTransfers.length,
        stuckPayouts: stuckPayouts.length, failedPayouts: failedPayouts.length, deadOutbox: deadOutbox.length, staleOpenPayments: staleOpenPayments.length,
      },
      openItems,
      webhookEvents: webhookEvents.map(({ payload: _p, ...e }) => e),
      failedTransfers, stuckTransfers, stuckPayouts, failedPayouts, deadOutbox, staleOpenPayments,
    };
  }

  async getWebhookEvent(id: string) {
    const e = await this.prisma.webhookEvent.findUnique({ where: { id } });
    if (!e) throw new DomainError('NOT_FOUND', 'Webhook event not found');
    return e;
  }

  async resolveWebhookEvent(admin: AdminPrincipal, id: string, resolution: string) {
    const before = await this.getWebhookEvent(id);
    if (before.status !== 'UNMATCHED' && before.status !== 'FAILED') throw new DomainError('INVALID_STATE', `Event is ${before.status}`);
    if (before.resolvedAt) throw new DomainError('INVALID_STATE', 'Event already resolved');
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.webhookEvent.update({ where: { id }, data: { resolvedAt: new Date(), resolvedBy: admin.id, resolution } });
      await this.audit.record({ actorId: admin.id, action: 'webhook_event.resolve', entity: 'WebhookEvent', entityId: id, before: { status: before.status }, after: { resolution } }, tx);
      return after;
    });
  }

  /** Re-runs a FAILED event (e.g. after fixing config). */
  async replayWebhookEvent(admin: AdminPrincipal, id: string) {
    const before = await this.getWebhookEvent(id);
    if (before.status !== 'FAILED') throw new DomainError('INVALID_STATE', `Only FAILED events can be replayed (is ${before.status})`);
    const ack = await this.receiver.replayStored(id);
    await this.audit.record({ actorId: admin.id, action: 'webhook_event.replay', entity: 'WebhookEvent', entityId: id, before: { status: before.status }, after: ack });
    return ack;
  }

  async listRuns(q: { limit: number; cursor?: string }) {
    const rows = await this.prisma.reconciliationRun.findMany({ orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], ...cursorArgs(q.limit, q.cursor) });
    return page(rows, q.limit);
  }

  async getRun(id: string) {
    const run = await this.prisma.reconciliationRun.findUnique({ where: { id }, include: { items: { orderBy: { createdAt: 'asc' } } } });
    if (!run) throw new DomainError('NOT_FOUND', 'Reconciliation run not found');
    return run;
  }

  async runReconciliation(admin: AdminPrincipal, date?: string) {
    const { start, end } = date
      ? { start: new Date(`${date}T00:00:00Z`), end: new Date(new Date(`${date}T00:00:00Z`).getTime() + 24 * HOUR) }
      : NightlyReconciliationService.previousDay();
    if (Number.isNaN(start.getTime()) || end > new Date(Date.now() + HOUR)) throw new DomainError('VALIDATION', 'Pick a past UTC day');
    const run = await this.reconciliation.run(start, end, admin.id);
    await this.audit.record({ actorId: admin.id, action: 'reconciliation.run', entity: 'ReconciliationRun', entityId: run.id, after: { windowStart: start, windowEnd: end, stats: run.stats } });
    return this.getRun(run.id);
  }

  async resolveItem(admin: AdminPrincipal, id: string, resolution: string) {
    const before = await this.prisma.reconciliationItem.findUnique({ where: { id } });
    if (!before) throw new DomainError('NOT_FOUND', 'Reconciliation item not found');
    if (before.status !== 'OPEN') throw new DomainError('INVALID_STATE', `Item is ${before.status}`);
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.reconciliationItem.update({ where: { id }, data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedBy: admin.id, resolution } });
      await this.audit.record({ actorId: admin.id, action: 'reconciliation_item.resolve', entity: 'ReconciliationItem', entityId: id, before: { status: before.status }, after: { status: after.status, resolution } }, tx);
      return after;
    });
  }

  // ── Audit ──────────────────────────────────────────────────────────────────

  async auditLog(q: { limit: number; cursor?: string; entity?: string; entityId?: string; actorId?: string }) {
    const rows = await this.prisma.auditLog.findMany({
      where: { ...(q.entity ? { entity: q.entity } : {}), ...(q.entityId ? { entityId: q.entityId } : {}), ...(q.actorId ? { actorId: q.actorId } : {}) },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      ...cursorArgs(q.limit, q.cursor),
    });
    return page(rows, q.limit);
  }
}

type PaymentRow = Prisma.PaymentGetPayload<{ include: { obligation: { include: { payer: true; fee: { include: { feeType: true } } } }; receipt: true } }>;

/** Matches what a payer or Monime support quotes: our ref, Monime's order number, or spm-… id. */
function refFilter(raw: string): Prisma.PaymentWhereInput {
  const v = raw.trim();
  const ref = normalizePublicRef(v);
  return { OR: [{ monimePaymentId: v }, ...(ref ? [{ paymentRef: ref }, { monimeOrderNumber: ref }] : [])] };
}

function presentPayment(p: PaymentRow) {
  const { obligation: o, receipt, ...rest } = p;
  return {
    ...rest,
    feeTypeCode: o.fee.feeType.code,
    feeName: o.fee.name,
    payer: { kind: o.payer.kind, ref: o.payer.ref, fullName: o.payer.fullName, programCode: o.payer.programCode, department: o.payer.department },
    receiptNumber: receipt?.number ?? null,
  };
}
