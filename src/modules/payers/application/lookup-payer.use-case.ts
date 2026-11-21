import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainError } from '../../../shared/domain/errors';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { AcademicsService } from '../../academics/application/academics.service';
import type { PayerKind } from '../../catalog/domain/payer-profile';
import type { Payer } from '../domain/payer';
import { ObligationSync } from './obligation-sync';
import { PayerDirectory } from './payer-directory';
import { PAYER_REPOSITORY, type PayerRepository } from './payer.repository';

/** A stored record older than this is refreshed from the portal on lookup (portal events keep it current). */
export const REFRESH_AFTER_MS = 30 * 24 * 60 * 60_000;

export interface LookupResult {
  payer: Payer;
  /** true when the portal was down and we served a record older than REFRESH_AFTER_MS */
  stale: boolean;
  createdObligations: number;
}

/**
 * Our store first (portal events keep it current); the portal only for someone we've
 * never seen, or a record not refreshed for 30 days. Then lazy creation of missing
 * obligations, atomically. If the portal is down, a stored record is still served.
 */
@Injectable()
export class LookupPayerUseCase {
  private readonly logger = new Logger(LookupPayerUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly directory: PayerDirectory,
    private readonly academics: AcademicsService,
    private readonly obligations: ObligationSync,
    @Inject(PAYER_REPOSITORY) private readonly payers: PayerRepository,
  ) {}

  async execute(kind: PayerKind, ref: string, now = new Date()): Promise<LookupResult> {
    const stored = await this.payers.find(kind, ref);
    let payer: Payer;
    let stale = false;
    if (stored && now.getTime() - stored.snapshotAt.getTime() < REFRESH_AFTER_MS) {
      payer = stored;
    } else {
      try {
        payer = await this.payers.upsertSnapshot(await this.directory.fetch(kind, ref), now);
        await this.academics.registerSeen(payer.department); // never throws
      } catch (err) {
        if (!stored || !(err instanceof DomainError && (err.code === 'UPSTREAM_UNAVAILABLE' || err.code === 'PAYER_NOT_FOUND'))) throw err;
        // A record we hold that the portal can't find: keep serving it (events are the source of
        // changes) but say so in the logs.
        if (err.code === 'PAYER_NOT_FOUND') this.logger.warn(`Portal has no ${kind} ${ref}; serving our stored record`);
        payer = stored;
        stale = err.code === 'UPSTREAM_UNAVAILABLE';
      }
    }
    const createdObligations = await this.prisma.$transaction((tx) => this.obligations.ensure(payer, tx));
    return { payer, stale, createdObligations };
  }
}
