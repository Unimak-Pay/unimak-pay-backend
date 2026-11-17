import { Injectable, Logger } from '@nestjs/common';
import type { Db } from '../../../shared/infrastructure/prisma.service';
import type { SettlementResult } from '../../payments/application/settlement-result';
import type { ParsedAccountMovement, ParsedPayoutUpdate, ParsedTransferUpdate } from '../../webhooks/domain/monime-webhook';
import { canMovePayout } from '../domain/payout-policy';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const done = (outcome: SettlementResult['outcome'], note?: string): SettlementResult => ({ outcome, note, outboxKeys: [] });

/** Applies internal_transfer.*, payout.* and financial_account.* inside the webhook transaction. */
@Injectable()
export class TreasuryEventsService {
  private readonly logger = new Logger(TreasuryEventsService.name);

  async applyTransfer(tx: Db, ev: ParsedTransferUpdate, outcome: 'completed' | 'failed', at: Date): Promise<SettlementResult> {
    const byMonime = await tx.transfer.findUnique({ where: { monimeTransferId: ev.monimeTransferId } });
    const ours = ev.metadata['transferId'];
    const t = byMonime ?? (ours && UUID.test(ours) ? await tx.transfer.findUnique({ where: { id: ours } }) : null);
    if (!t) return done('IGNORED', 'Not a UNIMAK transfer');
    await tx.$queryRaw`SELECT id FROM "Transfer" WHERE id = ${t.id}::uuid FOR UPDATE`;
    const cur = (await tx.transfer.findUnique({ where: { id: t.id } }))!;

    if (outcome === 'completed') {
      if (cur.status === 'COMPLETED') return done('PROCESSED', 'Transfer already completed');
      const note = cur.status === 'FAILED' ? `Completed after being marked FAILED (${cur.failureCode ?? '-'})` : undefined;
      await tx.transfer.update({
        where: { id: cur.id },
        data: { status: 'COMPLETED', completedAt: at, monimeTransferId: cur.monimeTransferId ?? ev.monimeTransferId, failureCode: null },
      });
      return done('PROCESSED', note);
    }
    if (cur.status === 'COMPLETED') return done('UNMATCHED', 'internal_transfer.failed for a transfer already completed');
    await tx.transfer.update({
      where: { id: cur.id },
      data: {
        status: 'FAILED',
        monimeTransferId: cur.monimeTransferId ?? ev.monimeTransferId,
        failureCode: ev.failure?.code ?? 'unknown',
        failureMessage: ev.failure?.message ?? null,
      },
    });
    this.logger.warn(`Commission transfer ${cur.id} failed: ${ev.failure?.code ?? 'unknown'}`);
    return done('PROCESSED', `Transfer failed: ${ev.failure?.code ?? 'unknown'}`);
  }

  async applyPayout(tx: Db, ev: ParsedPayoutUpdate, outcome: 'completed' | 'failed', at: Date): Promise<SettlementResult> {
    const byMonime = await tx.payout.findUnique({ where: { monimePayoutId: ev.monimePayoutId } });
    const ours = ev.metadata['payoutId'];
    // The webhook can beat our own write of monimePayoutId after POST /payouts.
    const p = byMonime ?? (ours && UUID.test(ours) ? await tx.payout.findUnique({ where: { id: ours } }) : null);
    if (!p) return done('IGNORED', 'Not a UNIMAK payout');
    await tx.$queryRaw`SELECT id FROM "Payout" WHERE id = ${p.id}::uuid FOR UPDATE`;
    const cur = (await tx.payout.findUnique({ where: { id: p.id } }))!;
    const to = outcome === 'completed' ? 'COMPLETED' : 'FAILED';

    if (cur.status === to) return done('PROCESSED', `Payout already ${to.toLowerCase()}`);
    if (!canMovePayout(cur.status, to)) return done('UNMATCHED', `payout.${outcome} while payout is ${cur.status}`);
    const notes: string[] = [];
    if (ev.amount !== null && ev.amount !== cur.amount) notes.push(`Monime paid ${ev.amount}, payout was for ${cur.amount}`);
    await tx.payout.update({
      where: { id: cur.id },
      data: {
        status: to,
        monimePayoutId: cur.monimePayoutId ?? ev.monimePayoutId,
        ...(to === 'COMPLETED'
          ? { completedAt: at, fees: ev.fees }
          : { failureCode: ev.failure?.code ?? 'unknown', failureMessage: ev.failure?.message ?? null }),
      },
    });
    if (to === 'FAILED') notes.push(`Payout failed: ${ev.failure?.code ?? 'unknown'}`);
    return done('PROCESSED', notes.length ? notes.join('; ') : undefined);
  }

  /** Keeps the cached balance fresh; payload shape is undocumented, so best effort. */
  async applyAccountMovement(tx: Db, ev: ParsedAccountMovement, at: Date): Promise<SettlementResult> {
    if (!ev.accountId) return done('IGNORED', 'No financial account id in payload');
    const account = await tx.financialAccount.findUnique({ where: { monimeId: ev.accountId } });
    if (!account) return done('IGNORED', `Not a UNIMAK account (${ev.accountId})`);
    if (ev.balanceAfter === null) return done('PROCESSED', 'No balance in payload; cached balance unchanged');
    // Out-of-order delivery: only move forward in time.
    const r = await tx.financialAccount.updateMany({
      where: { id: account.id, OR: [{ balanceUpdatedAt: null }, { balanceUpdatedAt: { lte: at } }] },
      data: { availableBalance: ev.balanceAfter, balanceUpdatedAt: at },
    });
    return done('PROCESSED', r.count === 0 ? 'Older than cached balance; ignored' : undefined);
  }
}
