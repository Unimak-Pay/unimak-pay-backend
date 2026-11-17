import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Db } from '../../../shared/infrastructure/prisma.service';
import type { OutboxMessageInput } from '../domain/messages';

/** Writes outbox rows inside the caller's transaction. Idempotent on dedupeKey. */
@Injectable()
export class OutboxWriter {
  async enqueue(db: Db, messages: readonly OutboxMessageInput[]): Promise<string[]> {
    if (messages.length === 0) return [];
    await db.outboxMessage.createMany({
      data: messages.map((m) => ({
        type: m.type,
        dedupeKey: m.dedupeKey,
        payload: m.payload as unknown as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });
    return messages.map((m) => m.dedupeKey);
  }
}
