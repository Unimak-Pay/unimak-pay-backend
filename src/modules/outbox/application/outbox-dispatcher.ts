import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import type { OutboxType } from '../domain/messages';
import { afterFailure } from '../domain/retry';
import { OUTBOX_HANDLERS, type OutboxHandler } from './outbox-handler';

const LEASE = Prisma.sql`interval '2 minutes'`;

interface ClaimedRow {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
}

export interface DispatchSummary {
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
}

@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private readonly handlers: Map<string, OutboxHandler>;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OUTBOX_HANDLERS) handlers: OutboxHandler[],
  ) {
    this.handlers = new Map(handlers.map((h) => [h.type, h]));
  }

  /** Right after commit: try the messages just written. Never throws. */
  async dispatchKeys(dedupeKeys: readonly string[]): Promise<DispatchSummary> {
    if (dedupeKeys.length === 0) return { claimed: 0, sent: 0, retried: 0, dead: 0 };
    try {
      // Fresh messages we just wrote: no due-time check, so app/DB clock skew
      // can't make them look "not yet due" and defer them to the sweep.
      return await this.run(
        Prisma.sql`"dedupeKey" = ANY(${[...dedupeKeys]}::text[]) AND attempts = 0`,
        dedupeKeys.length,
      );
    } catch (err) {
      this.logger.error(`Inline dispatch failed (cron will retry): ${(err as Error).message}`);
      return { claimed: 0, sent: 0, retried: 0, dead: 0 };
    }
  }

  /** Cron sweep: everything due. */
  sweep(limit = 50): Promise<DispatchSummary> {
    return this.run(Prisma.sql`"nextAttemptAt" <= now()`, limit);
  }

  private async run(filter: Prisma.Sql, limit: number): Promise<DispatchSummary> {
    // Claim with a lease; SKIP LOCKED lets concurrent sweeps share the work.
    const rows = await this.prisma.$queryRaw<ClaimedRow[]>`
      UPDATE "OutboxMessage" SET "lockedUntil" = now() + ${LEASE}
      WHERE id IN (
        SELECT id FROM "OutboxMessage"
        WHERE status = 'PENDING'
          AND ("lockedUntil" IS NULL OR "lockedUntil" < now())
          AND ${filter}
        ORDER BY "nextAttemptAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, type, payload, attempts`;

    const summary: DispatchSummary = { claimed: rows.length, sent: 0, retried: 0, dead: 0 };
    for (const row of rows) {
      const outcome = await this.deliver(row);
      summary[outcome]++;
    }
    return summary;
  }

  private async deliver(row: ClaimedRow): Promise<'sent' | 'retried' | 'dead'> {
    const attempts = row.attempts + 1;
    try {
      const handler = this.handlers.get(row.type);
      if (!handler) throw new Error(`No handler for outbox type ${row.type}`);
      await handler.handle(row.payload as never);
      await this.prisma.outboxMessage.update({
        where: { id: row.id },
        data: { status: 'SENT', attempts, sentAt: new Date(), lockedUntil: null, lastError: null },
      });
      return 'sent';
    } catch (err) {
      const message = (err as Error).message.slice(0, 1000);
      const decision = afterFailure(attempts, new Date());
      await this.prisma.outboxMessage.update({
        where: { id: row.id },
        data:
          decision.kind === 'dead'
            ? { status: 'DEAD', attempts, lastError: message, lockedUntil: null }
            : { attempts, lastError: message, nextAttemptAt: decision.at, lockedUntil: null },
      });
      const level = decision.kind === 'dead' ? 'error' : 'warn';
      this.logger[level](`Outbox ${row.type as OutboxType} ${row.id} attempt ${attempts} failed: ${message}`);
      return decision.kind === 'dead' ? 'dead' : 'retried';
    }
  }
}
