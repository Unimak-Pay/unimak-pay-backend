import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { type Db, PrismaService } from '../../../shared/infrastructure/prisma.service';

export type WebhookOutcome = 'PROCESSED' | 'IGNORED' | 'UNMATCHED';
const FINAL = new Set(['PROCESSED', 'IGNORED', 'UNMATCHED']);
const ERROR_MAX = 2_000;

export interface InboxEvent {
  id: string;
  type: string;
  payload: unknown;
}

/** Webhook inbox keyed by Monime event id. */
@Injectable()
export class WebhookInbox {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records the event if new and row-locks it for this transaction (serializes
   * concurrent deliveries). False when an earlier delivery already finished it.
   */
  async claim(tx: Db, e: InboxEvent): Promise<boolean> {
    await tx.webhookEvent.createMany({
      data: [{ id: e.id, type: e.type, payload: e.payload as Prisma.InputJsonValue }],
      skipDuplicates: true,
    });
    const [row] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM "WebhookEvent" WHERE id = ${e.id} FOR UPDATE`;
    if (FINAL.has(row!.status)) return false;
    await tx.webhookEvent.update({ where: { id: e.id }, data: { attempts: { increment: 1 } } });
    return true;
  }

  async complete(tx: Db, id: string, outcome: WebhookOutcome, note?: string): Promise<void> {
    await tx.webhookEvent.update({
      where: { id },
      data: { status: outcome, error: note?.slice(0, ERROR_MAX) ?? null, processedAt: new Date() },
    });
  }

  /** Outside the rolled-back transaction. */
  async recordFailure(e: InboxEvent, error: string): Promise<void> {
    const message = error.slice(0, ERROR_MAX);
    await this.prisma.webhookEvent.upsert({
      where: { id: e.id },
      create: { id: e.id, type: e.type, payload: e.payload as Prisma.InputJsonValue, status: 'FAILED', attempts: 1, error: message },
      update: { status: 'FAILED', error: message, attempts: { increment: 1 } },
    });
  }
}
