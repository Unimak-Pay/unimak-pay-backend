import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DomainError } from '../../../shared/domain/errors';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { MONIME_CLIENT, type MonimeClient, MonimeError, type MonimePaymentRecord } from '../../integrations/monime/monime.port';
import { OutboxDispatcher } from '../../outbox/application/outbox-dispatcher';
import { SettlePaymentService } from '../../payments/application/settle-payment.service';

const MARGIN_MS = 60 * 60_000; // Monime createTime vs our completedAt around midnight
const MAX_PAGES_PER_ACCOUNT = 400; // 20,000 payments per account per run
const PAGE_SIZE = 50;

export interface RunStats {
  accounts: number;
  monimePaymentsScanned: number;
  monimePaymentsInWindow: number;
  alreadySettled: number;
  autoSettled: number;
  ourCompletedPayments: number;
  checkedAtMonime: number;
  commissionsChecked: number;
  openItems: number;
}

type ItemInput = Omit<Prisma.ReconciliationItemUncheckedCreateInput, 'runId' | 'id'>;

/**
 * Spec step 7: compares a window (default: yesterday, UTC = Sierra Leone time)
 * with Monime.
 *  1. Every completed Monime payment into a fee-type account must be one of our
 *     COMPLETED payments. A missed webhook is auto-settled through the same
 *     settlement step (collection never fails once at Monime, so it's safe);
 *     anything we can't match is flagged.
 *  2. Every payment we completed in the window must exist and be completed at
 *     Monime with the same amount.
 *  3. Every completed payment with a platform fee must have its commission
 *     transfer completed for exactly that fee.
 * Re-running a window doesn't duplicate open items.
 */
@Injectable()
export class NightlyReconciliationService {
  private readonly logger = new Logger(NightlyReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settle: SettlePaymentService,
    private readonly dispatcher: OutboxDispatcher,
    @Inject(MONIME_CLIENT) private readonly monime: MonimeClient,
  ) {}

  /** UTC day before `now`. */
  static previousDay(now = new Date()): { start: Date; end: Date } {
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return { start: new Date(end.getTime() - 24 * 60 * 60_000), end };
  }

  /** Nightly entry: skips a window that already has a completed run. */
  async runNightly(now = new Date()) {
    const { start, end } = NightlyReconciliationService.previousDay(now);
    const done = await this.prisma.reconciliationRun.findFirst({ where: { windowStart: start, windowEnd: end, status: 'COMPLETED' } });
    if (done) return { skipped: true, runId: done.id };
    return this.run(start, end, 'cron');
  }

  async run(start: Date, end: Date, triggeredBy: string) {
    if (!(start < end)) throw new DomainError('VALIDATION', 'Window start must be before end');
    const running = await this.prisma.reconciliationRun.findFirst({ where: { status: 'RUNNING', startedAt: { gt: new Date(Date.now() - 30 * 60_000) } } });
    if (running) throw new DomainError('INVALID_STATE', `Reconciliation run ${running.id} is already in progress`);

    const run = await this.prisma.reconciliationRun.create({ data: { windowStart: start, windowEnd: end, triggeredBy } });
    const stats: RunStats = {
      accounts: 0, monimePaymentsScanned: 0, monimePaymentsInWindow: 0, alreadySettled: 0, autoSettled: 0,
      ourCompletedPayments: 0, checkedAtMonime: 0, commissionsChecked: 0, openItems: 0,
    };
    try {
      const seen = new Set<string>();
      const settledNow = new Set<string>();
      for (const account of await this.prisma.financialAccount.findMany({ where: { purpose: 'FEE_TYPE' } })) {
        stats.accounts++;
        await this.scanAccount(run.id, account.monimeId, start, end, stats, seen, settledNow);
      }
      await this.checkOurPayments(run.id, start, end, stats, seen);
      await this.checkCommissions(run.id, start, end, stats, settledNow);
      stats.openItems = await this.prisma.reconciliationItem.count({ where: { runId: run.id, status: 'OPEN' } });
      return await this.prisma.reconciliationRun.update({ where: { id: run.id }, data: { status: 'COMPLETED', finishedAt: new Date(), stats: { ...stats } } });
    } catch (err) {
      this.logger.error(`Reconciliation ${run.id} failed: ${(err as Error).message}`);
      await this.prisma.reconciliationRun.update({ where: { id: run.id }, data: { status: 'FAILED', finishedAt: new Date(), stats: { ...stats }, error: (err as Error).message.slice(0, 2000) } });
      throw err;
    }
  }

  // ── 1. Monime → us ─────────────────────────────────────────────────────────

  private async scanAccount(runId: string, accountId: string, start: Date, end: Date, stats: RunStats, seen: Set<string>, settledNow: Set<string>) {
    let after: string | null = null;
    let newestFirst: boolean | null = null;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES_PER_ACCOUNT) {
        await this.item(runId, { kind: 'SCAN_TRUNCATED', financialAccountId: accountId, note: `Stopped after ${MAX_PAGES_PER_ACCOUNT} pages; some payments were not compared` });
        return;
      }
      const res = await this.monime.listPayments({ financialAccountId: accountId, after, limit: PAGE_SIZE });
      const items = res.items;
      if (items.length === 0) return;
      // TODO(monime): ordering isn't documented; detect it so a newest-first list can stop early.
      if (newestFirst === null && items.length > 1) newestFirst = items[0]!.createTime >= items[items.length - 1]!.createTime;

      for (const mp of items) {
        stats.monimePaymentsScanned++;
        if (mp.createTime >= new Date(start.getTime() - MARGIN_MS) && mp.createTime < new Date(end.getTime() + MARGIN_MS)) seen.add(mp.id);
        if (mp.createTime < start || mp.createTime >= end || mp.status !== 'completed') continue;
        stats.monimePaymentsInWindow++;
        await this.compareMonimePayment(runId, accountId, mp, stats, settledNow);
      }
      const oldest = items.reduce((m, x) => (x.createTime < m ? x.createTime : m), items[0]!.createTime);
      if (newestFirst && oldest < new Date(start.getTime() - MARGIN_MS)) return;
      if (!res.next) return;
      after = res.next;
    }
  }

  private async compareMonimePayment(runId: string, accountId: string, mp: MonimePaymentRecord, stats: RunStats, settledNow: Set<string>) {
    // Same step as the webhook: settles if we missed it, no-op if already applied.
    const result = await this.prisma.$transaction(
      (tx) => this.settle.applyCompleted(tx, {
        monimePaymentId: mp.id, financialAccountId: mp.financialAccountId, currency: mp.currency, amount: mp.amount, fees: mp.fees,
        reference: mp.reference, metadata: mp.metadata, ownerId: mp.ownerId, payerPhone: mp.payerPhone, orderNumber: mp.orderNumber, occurredAt: mp.updateTime ?? mp.createTime,
      }),
      { timeout: 15_000 },
    );
    const base = { monimePaymentId: mp.id, financialAccountId: accountId, paymentId: result.paymentId ?? null };

    if (result.outcome === 'PROCESSED' && result.receiptNumber) {
      stats.autoSettled++;
      settledNow.add(result.paymentId!);
      await this.item(runId, { ...base, kind: 'MISSED_WEBHOOK_SETTLED', status: 'AUTO_RESOLVED', actual: { amount: mp.amount.toString() }, note: `Webhook never arrived; settled from Monime (receipt ${result.receiptNumber})${result.note ? `. ${result.note}` : ''}` });
      if (result.outboxKeys.length) await this.dispatcher.dispatchKeys(result.outboxKeys);
      return;
    }
    if (result.outcome !== 'PROCESSED') {
      await this.item(runId, { ...base, kind: 'UNMATCHED_MONIME_PAYMENT', actual: { amount: mp.amount.toString(), reference: mp.reference }, note: result.note ?? 'No matching UNIMAK payment' });
      return;
    }
    stats.alreadySettled++;
    const ours = await this.prisma.payment.findUnique({ where: { id: result.paymentId! } });
    if (ours && mp.fees !== ours.monimeFee) {
      await this.item(runId, { ...base, kind: 'MONIME_FEE_MISMATCH', expected: { monimeFee: ours.monimeFee.toString() }, actual: { monimeFee: mp.fees.toString() }, note: `Monime took ${mp.fees}, our pricing says ${ours.monimeFee}` });
    }
  }

  // ── 2. us → Monime ─────────────────────────────────────────────────────────

  private async checkOurPayments(runId: string, start: Date, end: Date, stats: RunStats, seen: Set<string>) {
    const ours = await this.prisma.payment.findMany({ where: { status: 'COMPLETED', completedAt: { gte: start, lt: end } } });
    stats.ourCompletedPayments = ours.length;
    for (const p of ours) {
      if (!p.monimePaymentId) {
        await this.item(runId, { kind: 'MISSING_AT_MONIME', paymentId: p.id, note: 'Completed payment has no Monime payment id' });
        continue;
      }
      if (seen.has(p.monimePaymentId)) continue;
      stats.checkedAtMonime++;
      let mp: MonimePaymentRecord;
      try {
        mp = await this.monime.getPayment(p.monimePaymentId);
      } catch (err) {
        if (err instanceof MonimeError && err.code === 'NOT_FOUND') {
          await this.item(runId, { kind: 'MISSING_AT_MONIME', paymentId: p.id, monimePaymentId: p.monimePaymentId, expected: { amount: p.amount.toString() }, note: 'Monime has no such payment' });
          continue;
        }
        throw err;
      }
      if (mp.status !== 'completed') {
        await this.item(runId, { kind: 'MISSING_AT_MONIME', paymentId: p.id, monimePaymentId: mp.id, actual: { status: mp.status }, note: `Monime payment is ${mp.status}, we have it COMPLETED` });
      } else if (mp.amount !== p.amount) {
        await this.item(runId, { kind: 'AMOUNT_MISMATCH', paymentId: p.id, monimePaymentId: mp.id, expected: { amount: p.amount.toString() }, actual: { amount: mp.amount.toString() }, note: `Monime collected ${mp.amount}, we recorded ${p.amount}` });
      }
    }
  }

  // ── 3. commission ──────────────────────────────────────────────────────────

  private async checkCommissions(runId: string, start: Date, end: Date, stats: RunStats, settledNow: Set<string>) {
    const paid = await this.prisma.payment.findMany({ where: { status: 'COMPLETED', completedAt: { gte: start, lt: end }, platformFee: { gt: 0n } } });
    const transfers = new Map((await this.prisma.transfer.findMany({ where: { paymentId: { in: paid.map((p) => p.id) } } })).map((t) => [t.paymentId!, t]));
    for (const p of paid) {
      if (settledNow.has(p.id)) continue; // its transfer was only just queued
      stats.commissionsChecked++;
      const t = transfers.get(p.id);
      const expected = { amount: p.platformFee.toString() };
      if (!t) {
        await this.item(runId, { kind: 'COMMISSION_MISSING', paymentId: p.id, expected, note: 'No commission transfer for this payment' });
      } else if (t.amount !== p.platformFee) {
        await this.item(runId, { kind: 'COMMISSION_AMOUNT_MISMATCH', paymentId: p.id, transferId: t.id, expected, actual: { amount: t.amount.toString() }, note: `Transfer is ${t.amount}, platform fee is ${p.platformFee}` });
      } else if (t.status !== 'COMPLETED') {
        await this.item(runId, { kind: 'COMMISSION_NOT_COMPLETED', paymentId: p.id, transferId: t.id, expected, actual: { status: t.status, failureCode: t.failureCode }, note: `Commission transfer is ${t.status}${t.failureCode ? ` (${t.failureCode})` : ''}` });
      }
    }
  }

  /** Doesn't duplicate an item that is still OPEN from an earlier run. */
  private async item(runId: string, i: ItemInput): Promise<void> {
    if ((i.status ?? 'OPEN') === 'OPEN') {
      const dup = await this.prisma.reconciliationItem.findFirst({
        where: {
          status: 'OPEN', kind: i.kind,
          ...(i.paymentId ? { paymentId: i.paymentId } : {}),
          ...(i.monimePaymentId ? { monimePaymentId: i.monimePaymentId } : {}),
          ...(!i.paymentId && !i.monimePaymentId ? { financialAccountId: i.financialAccountId ?? null } : {}),
        },
      });
      if (dup) return;
    }
    await this.prisma.reconciliationItem.create({ data: { ...i, runId } });
  }
}
