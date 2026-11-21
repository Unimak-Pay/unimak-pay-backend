import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { AcademicsService } from '../../academics/application/academics.service';
import { parsePortalEvent, refOf } from '../domain/portal-event';
import { ObligationSync } from './obligation-sync';
import { PAYER_REPOSITORY, type PayerRepository } from './payer.repository';

export type PortalEventResultCode = 'APPLIED' | 'DUPLICATE' | 'STALE' | 'REJECTED';

export interface PortalEventOutcome {
  id: string;
  result: PortalEventResultCode;
  error?: { code: 'VALIDATION'; message: string };
}

/** One event as received; the envelope (id) is checked by the controller. */
export type RawPortalEvent = Record<string, unknown> & { id: string };

/**
 * docs/portal-events.md B1. Each event in its own transaction:
 * duplicate id → DUPLICATE; invalid → REJECTED (logged); older than what we hold
 * (portal updatedAt) → STALE; otherwise the payer record is replaced and missing
 * obligations created. Events for the same record serialize on an advisory lock.
 */
@Injectable()
export class ApplyPortalEventsUseCase {
  private readonly logger = new Logger(ApplyPortalEventsUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly academics: AcademicsService,
    private readonly obligations: ObligationSync,
    @Inject(PAYER_REPOSITORY) private readonly payers: PayerRepository,
  ) {}

  async execute(events: readonly RawPortalEvent[], now = new Date()): Promise<PortalEventOutcome[]> {
    const out: PortalEventOutcome[] = [];
    for (const e of events) out.push(await this.applyOne(e, now));
    return out;
  }

  private async applyOne(e: RawPortalEvent, now: Date): Promise<PortalEventOutcome> {
    const { id, ...rest } = e;
    const parsed = parsePortalEvent(rest);
    const log = {
      id, type: typeof e['type'] === 'string' ? (e['type'] as string).slice(0, 50) : 'unknown',
      ref: parsed.ok ? parsed.event.snapshot.ref : parsed.ref ?? refOf(e['type'], e['data']),
      data: (e['data'] ?? null) as Prisma.InputJsonValue,
      occurredAt: parsed.ok ? parsed.event.occurredAt : null,
    };
    try {
      const outcome = await this.prisma.$transaction(async (tx) => {
        if (await tx.portalEvent.findUnique({ where: { id }, select: { id: true } })) return { id, result: 'DUPLICATE' } as PortalEventOutcome;
        if (!parsed.ok) {
          await tx.portalEvent.create({ data: { ...log, result: 'REJECTED', error: parsed.error } });
          return { id, result: 'REJECTED', error: { code: 'VALIDATION', message: parsed.error } } as PortalEventOutcome;
        }
        const { snapshot, portalUpdatedAt } = parsed.event;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payer:${snapshot.kind}:${snapshot.ref}`}))`;
        const current = await this.payers.find(snapshot.kind, snapshot.ref, tx);
        if (current?.portalUpdatedAt && current.portalUpdatedAt >= portalUpdatedAt) {
          await tx.portalEvent.create({ data: { ...log, result: 'STALE' } });
          return { id, result: 'STALE' } as PortalEventOutcome;
        }
        const payer = await this.payers.upsertSnapshot(snapshot, now, tx, portalUpdatedAt);
        await this.obligations.ensure(payer, tx, 'system:portal-event');
        await tx.portalEvent.create({ data: { ...log, result: 'APPLIED' } });
        return { id, result: 'APPLIED' } as PortalEventOutcome;
      });
      if (outcome.result === 'APPLIED' && parsed.ok) await this.academics.registerSeen(parsed.event.snapshot.department); // never throws
      return outcome;
    } catch (err) {
      // the same id arriving twice at once: the other request recorded it
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { id, result: 'DUPLICATE' };
      this.logger.error(`Portal event ${id} failed: ${(err as Error).message}`);
      throw err;
    }
  }
}
