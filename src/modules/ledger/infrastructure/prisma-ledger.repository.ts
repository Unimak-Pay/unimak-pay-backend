import { Injectable } from '@nestjs/common';
import { type Db, PrismaService } from '../../../shared/infrastructure/prisma.service';
import type {
  AppendEntry,
  LedgerRepository,
  ObligationLedger,
} from '../application/ledger.repository';

@Injectable()
export class PrismaLedgerRepository implements LedgerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async ledgersFor(
    obligationIds: readonly string[],
    db: Db = this.prisma,
  ): Promise<Map<string, ObligationLedger>> {
    const ids = [...obligationIds];
    const result = new Map<string, ObligationLedger>(
      ids.map((id) => [id, { entries: [], pending: [] }]),
    );
    if (ids.length === 0) return result;
    const [entries, pending] = await Promise.all([
      db.ledgerEntry.groupBy({
        by: ['obligationId', 'type'],
        where: { obligationId: { in: ids } },
        _sum: { amount: true },
      }),
      db.payment.findMany({
        where: { obligationId: { in: ids }, status: { in: ['INITIATED', 'PENDING'] } },
        select: { obligationId: true, amount: true, status: true, expiresAt: true },
      }),
    ]);
    for (const e of entries) {
      result.get(e.obligationId)?.entries.push({ type: e.type, amount: e._sum.amount ?? 0n });
    }
    for (const p of pending) result.get(p.obligationId)?.pending.push(p);
    return result;
  }

  async append(entry: AppendEntry, db: Db): Promise<void> {
    await db.ledgerEntry.create({
      data: {
        obligationId: entry.obligationId,
        type: entry.type,
        amount: entry.amount,
        paymentId: entry.paymentId ?? null,
        memo: entry.memo ?? null,
        createdBy: entry.createdBy,
      },
    });
  }
}
