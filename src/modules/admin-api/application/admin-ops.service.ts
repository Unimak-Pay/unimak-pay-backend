import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DomainError } from '../../../shared/domain/errors';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { AcademicsService, type DepartmentNames, NO_NAMES } from '../../academics/application/academics.service';
import { AuditService } from '../../audit/audit.service';
import type { AdminPrincipal } from '../../auth/application/admin-principal';
import { COMMISSION_PERMISSION } from '../../auth/domain/permissions';
import { COMMISSION_OUTBOX_TYPE } from '../../outbox/domain/messages';
import { MONIME_CLIENT, type MonimeClient } from '../../integrations/monime/monime.port';
import { OutboxDispatcher } from '../../outbox/application/outbox-dispatcher';
import { ReconcilePaymentUseCase } from '../../payments/application/reconcile-payment.use-case';
import { NightlyReconciliationService } from '../../reconciliation/application/nightly-reconciliation.service';
import { CommissionTransferService } from '../../treasury/application/commission-transfer.service';
import { MonimeWebhookReceiver } from '../../webhooks/application/monime-webhook.receiver';
import { normalizePublicRef } from '../../payments/domain/payment-ref';
import { CSV_COLUMNS, csvRow, EXPORT_BATCH, EXPORT_MAX_ROWS } from './payments-csv';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

function page<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.id : null };
}

const cursorArgs = (limit: number, cursor?: string) => ({ take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });

export type Sort = 'createdAt' | '-createdAt' | 'amount' | '-amount';
/** `-field` = descending; id breaks ties so cursor paging is stable under any sort. */
function orderBy(sort: Sort = '-createdAt'): [{ createdAt: 'asc' | 'desc' } | { amount: 'asc' | 'desc' }, { id: 'asc' | 'desc' }] {
  const dir = sort.startsWith('-') ? 'desc' : 'asc';
  const field = sort.replace(/^-/, '') as 'createdAt' | 'amount';
  return [field === 'amount' ? { amount: dir } : { createdAt: dir }, { id: dir }];
}
const HOUR = 60 * 60_000;

/** Read models and operator actions behind /v1/admin. Every write is audited. */
/** Commission transfers are only for super admins and holders of transfers.read. */
function canSeeCommission(admin: AdminPrincipal): boolean {
  return admin.permissions.has(COMMISSION_PERMISSION);
}

/** Outbox messages that send commission transfers are hidden from everyone else. */
function outboxScope(admin: AdminPrincipal): Prisma.OutboxMessageWhereInput {
  return canSeeCommission(admin) ? {} : { type: { not: COMMISSION_OUTBOX_TYPE } };
}

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
    private readonly academics: AcademicsService,
  ) {}

  // ── Payments ───────────────────────────────────────────────────────────────

  /** Heads of department only see payments of payers in their departments. */
  private paymentScope(admin: AdminPrincipal): Prisma.PaymentWhereInput {
    return admin.departmentScoped ? { obligation: { payer: { department: { in: [...admin.departments] } } } } : {};
  }

  async paymentsWhere(admin: AdminPrincipal, q: PaymentFilters): Promise<Prisma.PaymentWhereInput> {
    // a faculty is its departments as they are now
    const facultyDepartments = q.faculty
      ? (await this.prisma.department.findMany({ where: { faculty: { code: q.faculty } }, select: { code: true } })).map((d) => d.code)
      : null;
    return {
      AND: [
        this.paymentScope(admin),
        q.status ? { status: q.status as never } : {},
        q.channel ? { channel: q.channel as never } : {},
        q.feeType ? { obligation: { fee: { feeType: { code: q.feeType } } } } : {},
        q.payerRef ? { obligation: { payer: { ref: q.payerRef } } } : {},
        q.department ? { obligation: { payer: { department: q.department } } } : {},
        q.ref ? refFilter(q.ref) : {},
        facultyDepartments ? { obligation: { payer: { department: { in: facultyDepartments } } } } : {},
        q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } } : {},
      ],
    };
  }

  async listPayments(admin: AdminPrincipal, q: PaymentFilters & { limit: number; cursor?: string; sort?: Sort }) {
    const rows = await this.prisma.payment.findMany({
      where: await this.paymentsWhere(admin, q),
      orderBy: orderBy(q.sort),
      include: { obligation: { include: { payer: true, fee: { include: { feeType: true } } } }, receipt: true },
      ...cursorArgs(q.limit, q.cursor),
    });
    const names = await this.academics.names(rows.map((r) => r.obligation.payer.department));
    return page(rows.map((r) => presentPayment(r, names)), q.limit);
  }

  /**
   * CSV of payments matching the list filters, oldest first, in batches (at most
   * EXPORT_MAX_ROWS; narrow the filters beyond that). Audited.
   */
  async *exportPayments(admin: AdminPrincipal, q: PaymentFilters): AsyncGenerator<string> {
    const where = await this.paymentsWhere(admin, q);
    const total = await this.prisma.payment.count({ where });
    if (total > EXPORT_MAX_ROWS) {
      throw new DomainError('VALIDATION', `${total} payments match; exports are limited to ${EXPORT_MAX_ROWS}. Narrow the date range or filters.`);
    }
    await this.audit.record({ actorId: admin.id, action: 'payments.export', entity: 'Payment', entityId: 'export', after: { filters: q, rows: total } });
    yield `${CSV_COLUMNS.join(',')}\r\n`;
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.payment.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { obligation: { include: { payer: true, fee: { include: { feeType: true } } } }, receipt: true },
        take: EXPORT_BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const names = await this.academics.names(rows.map((r) => r.obligation.payer.department));
      if (rows.length) yield rows.map((r) => `${csvRow(r, names.get(r.obligation.payer.department ?? '') ?? NO_NAMES)}\r\n`).join('');
      if (rows.length < EXPORT_BATCH) return;
      cursor = rows[rows.length - 1]!.id;
    }
  }

  async getPayment(admin: AdminPrincipal, id: string) {
    const p = await this.prisma.payment.findFirst({
      where: { id, ...this.paymentScope(admin) },
      include: { obligation: { include: { payer: true, fee: { include: { feeType: true } } } }, receipt: true, ledgerEntry: true },
    });
    if (!p) throw new DomainError('NOT_FOUND', 'Payment not found');
    const transfer = canSeeCommission(admin) ? await this.prisma.transfer.findUnique({ where: { paymentId: id } }) : null;
    const names = await this.academics.names([p.obligation.payer.department]);
    return { ...presentPayment(p, names), ledgerEntry: p.ledgerEntry, commissionTransfer: transfer };
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

  async listPayouts(q: { limit: number; cursor?: string; status?: string; sort?: Sort }) {
    const rows = await this.prisma.payout.findMany({
      where: q.status ? { status: q.status as never } : {},
      include: { financialAccount: { select: { reference: true, monimeId: true } } },
      orderBy: orderBy(q.sort),
      ...cursorArgs(q.limit, q.cursor),
    });
    return page(rows, q.limit);
  }

  async getPayout(id: string) {
    const p = await this.prisma.payout.findUnique({ where: { id }, include: { financialAccount: true } });
    if (!p) throw new DomainError('NOT_FOUND', 'Payout not found');
    return p;
  }

  async listTransfers(q: { limit: number; cursor?: string; status?: string; sort?: Sort }) {
    const rows = await this.prisma.transfer.findMany({
      where: q.status ? { status: q.status as never } : {},
      orderBy: orderBy(q.sort),
      ...cursorArgs(q.limit, q.cursor),
    });
    return page(rows, q.limit);
  }

  async getTransfer(id: string) {
    const t = await this.prisma.transfer.findUnique({ where: { id } });
    if (!t) throw new DomainError('NOT_FOUND', 'Transfer not found');
    return t;
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

  async listOutbox(admin: AdminPrincipal, q: { limit: number; cursor?: string; status?: string }) {
    const rows = await this.prisma.outboxMessage.findMany({
      where: { ...(q.status ? { status: q.status as never } : {}), ...outboxScope(admin) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(q.limit, q.cursor),
    });
    return page(rows, q.limit);
  }

  async getOutbox(admin: AdminPrincipal, id: string) {
    const m = await this.prisma.outboxMessage.findFirst({ where: { id, ...outboxScope(admin) } });
    if (!m) throw new DomainError('NOT_FOUND', 'Outbox message not found');
    return m;
  }

  async retryOutbox(admin: AdminPrincipal, id: string) {
    const before = await this.prisma.outboxMessage.findFirst({ where: { id, ...outboxScope(admin) } });
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
  async reconciliationSummary(admin: AdminPrincipal, now = new Date()) {
    const commission = canSeeCommission(admin);
    const hourAgo = new Date(now.getTime() - HOUR);
    const w = {
      openItems: { status: 'OPEN' } satisfies Prisma.ReconciliationItemWhereInput,
      webhookEvents: { status: { in: ['UNMATCHED', 'FAILED'] }, resolvedAt: null } satisfies Prisma.WebhookEventWhereInput,
      failedTransfers: { status: 'FAILED' } satisfies Prisma.TransferWhereInput,
      stuckTransfers: { status: { in: ['PENDING', 'SUBMITTED'] }, createdAt: { lt: hourAgo } } satisfies Prisma.TransferWhereInput,
      stuckPayouts: { status: { in: ['REQUESTED', 'SUBMITTED', 'PROCESSING'] }, createdAt: { lt: hourAgo } } satisfies Prisma.PayoutWhereInput,
      failedPayouts: { status: 'FAILED', updatedAt: { gt: new Date(now.getTime() - 7 * 24 * HOUR) } } satisfies Prisma.PayoutWhereInput,
      deadOutbox: { status: 'DEAD', ...outboxScope(admin) } satisfies Prisma.OutboxMessageWhereInput,
      // Monime said processing started an hour ago and nothing completed it yet
      staleOpenPayments: { status: 'PROCESSING', processingAt: { lt: new Date(now.getTime() - 60 * 60_000) } } satisfies Prisma.PaymentWhereInput,
    };
    // Lists show the latest SUMMARY_LIST_LIMIT of each; counts are exact.
    const take = SUMMARY_LIST_LIMIT;
    const [openItems, webhookEvents, failedTransfers, stuckTransfers, stuckPayouts, failedPayouts, deadOutbox, staleOpenPayments, counts] = await Promise.all([
      this.prisma.reconciliationItem.findMany({ where: w.openItems, orderBy: { createdAt: 'desc' }, take }),
      this.prisma.webhookEvent.findMany({ where: w.webhookEvents, orderBy: { receivedAt: 'desc' }, take, omit: { payload: true } }),
      commission ? this.prisma.transfer.findMany({ where: w.failedTransfers, orderBy: { updatedAt: 'desc' }, take }) : null,
      commission ? this.prisma.transfer.findMany({ where: w.stuckTransfers, orderBy: { createdAt: 'asc' }, take }) : null,
      this.prisma.payout.findMany({ where: w.stuckPayouts, orderBy: { createdAt: 'asc' }, take }),
      this.prisma.payout.findMany({ where: w.failedPayouts, orderBy: { updatedAt: 'desc' }, take }),
      this.prisma.outboxMessage.findMany({ where: w.deadOutbox, orderBy: { createdAt: 'desc' }, take }),
      this.prisma.payment.findMany({ where: w.staleOpenPayments, orderBy: { processingAt: 'asc' }, take }),
      Promise.all([
        this.prisma.reconciliationItem.count({ where: w.openItems }),
        this.prisma.webhookEvent.count({ where: w.webhookEvents }),
        commission ? this.prisma.transfer.count({ where: w.failedTransfers }) : null,
        commission ? this.prisma.transfer.count({ where: w.stuckTransfers }) : null,
        this.prisma.payout.count({ where: w.stuckPayouts }),
        this.prisma.payout.count({ where: w.failedPayouts }),
        this.prisma.outboxMessage.count({ where: w.deadOutbox }),
        this.prisma.payment.count({ where: w.staleOpenPayments }),
      ]),
    ]);
    const [cOpen, cEvents, cFailedT, cStuckT, cStuckP, cFailedP, cDead, cStale] = counts;
    return {
      lastRun: await this.prisma.reconciliationRun.findFirst({ orderBy: { startedAt: 'desc' } }),
      counts: {
        openItems: cOpen, webhookEvents: cEvents, failedTransfers: cFailedT, stuckTransfers: cStuckT,
        stuckPayouts: cStuckP, failedPayouts: cFailedP, deadOutbox: cDead, staleOpenPayments: cStale,
      },
      /** each list holds at most this many (the counts are exact) */
      listLimit: take,
      openItems,
      webhookEvents,
      failedTransfers, stuckTransfers, stuckPayouts, failedPayouts, deadOutbox, staleOpenPayments,
    };
  }

  /** Without payloads; GET /webhook-events/:id has it. */
  async listWebhookEvents(q: { limit: number; cursor?: string; status?: string; type?: string; unresolved?: boolean }) {
    const rows = await this.prisma.webhookEvent.findMany({
      where: { ...(q.status ? { status: q.status as never } : {}), ...(q.type ? { type: q.type } : {}), ...(q.unresolved ? { resolvedAt: null } : {}) },
      omit: { payload: true },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(q.limit, q.cursor),
    });
    return page(rows, q.limit);
  }

  async listItems(q: { limit: number; cursor?: string; status?: string; runId?: string; kind?: string }) {
    const rows = await this.prisma.reconciliationItem.findMany({
      where: { ...(q.status ? { status: q.status as never } : {}), ...(q.runId ? { runId: q.runId } : {}), ...(q.kind ? { kind: q.kind } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(q.limit, q.cursor),
    });
    return page(rows, q.limit);
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

  async listRuns(q: { limit: number; cursor?: string; status?: string }) {
    const rows = await this.prisma.reconciliationRun.findMany({
      where: q.status ? { status: q.status as never } : {},
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(q.limit, q.cursor),
    });
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

export const SUMMARY_LIST_LIMIT = 100;

export interface PaymentFilters { status?: string; channel?: string; feeType?: string; payerRef?: string; ref?: string; from?: string; to?: string; department?: string; faculty?: string }

type PaymentRow = Prisma.PaymentGetPayload<{ include: { obligation: { include: { payer: true; fee: { include: { feeType: true } } } }; receipt: true } }>;

/** Matches what a payer or Monime support quotes: our ref, Monime's order number, or spm-… id. */
function refFilter(raw: string): Prisma.PaymentWhereInput {
  const v = raw.trim();
  const ref = normalizePublicRef(v);
  return { OR: [{ monimePaymentId: v }, ...(ref ? [{ paymentRef: ref }, { monimeOrderNumber: ref }] : [])] };
}

function presentPayment(p: PaymentRow, names: Map<string, DepartmentNames>) {
  const { obligation: o, receipt, ...rest } = p;
  const n = (o.payer.department && names.get(o.payer.department)) || null;
  return {
    ...rest,
    feeTypeCode: o.fee.feeType.code,
    feeName: o.fee.name,
    payer: {
      kind: o.payer.kind, ref: o.payer.ref, fullName: o.payer.fullName, programCode: o.payer.programCode,
      department: o.payer.department, departmentName: n?.departmentName ?? null, facultyCode: n?.facultyCode ?? null, facultyName: n?.facultyName ?? null,
    },
    receiptNumber: receipt?.number ?? null,
  };
}
