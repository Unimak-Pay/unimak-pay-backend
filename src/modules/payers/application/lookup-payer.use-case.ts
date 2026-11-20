import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainError } from '../../../shared/domain/errors';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { AcademicsService } from '../../academics/application/academics.service';
import { CATALOG_REPOSITORY, type CatalogRepository } from '../../catalog/application/catalog.repository';
import type { PayerKind } from '../../catalog/domain/payer-profile';
import { LEDGER_REPOSITORY, type LedgerRepository } from '../../ledger/application/ledger.repository';
import { planObligations } from '../domain/obligation-planner';
import { type Payer, toProfile } from '../domain/payer';
import { PayerDirectory } from './payer-directory';
import { PAYER_REPOSITORY, type PayerRepository } from './payer.repository';

export interface LookupResult {
  payer: Payer;
  /** true when the portal was down and we served the last snapshot */
  stale: boolean;
  createdObligations: number;
}

/**
 * Portal lookup → payer snapshot upsert → lazy creation of missing obligations
 * (each with its CHARGE ledger entry, atomically).
 */
@Injectable()
export class LookupPayerUseCase {
  private readonly logger = new Logger(LookupPayerUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly directory: PayerDirectory,
    private readonly academics: AcademicsService,
    @Inject(PAYER_REPOSITORY) private readonly payers: PayerRepository,
    @Inject(CATALOG_REPOSITORY) private readonly catalog: CatalogRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
  ) {}

  async execute(kind: PayerKind, ref: string, now = new Date()): Promise<LookupResult> {
    let payer: Payer;
    let stale = false;
    try {
      payer = await this.payers.upsertSnapshot(await this.directory.fetch(kind, ref), now);
      await this.academics.registerSeen(payer.department); // never throws
    } catch (err) {
      // Portal down: serve the last snapshot rather than blocking a payment.
      const cached = err instanceof DomainError && err.code === 'UPSTREAM_UNAVAILABLE'
        ? await this.payers.find(kind, ref)
        : null;
      if (!cached) throw err;
      payer = cached;
      stale = true;
    }

    const [fees, existing] = await Promise.all([
      this.catalog.activeFeesFor(kind),
      this.payers.existingObligationRefs(payer.id),
    ]);
    const plan = planObligations(toProfile(payer), fees, existing);
    for (const s of plan.skipped) {
      this.logger.warn(`Payer ${kind} ${ref} eligible for fee ${s.feeId} but ${s.reason}`);
    }

    let created = 0;
    if (plan.create.length > 0) {
      created = await this.prisma.$transaction(async (tx) => {
        let n = 0;
        for (const p of plan.create) {
          const id = await this.payers.insertObligationIfAbsent(payer.id, p, tx);
          if (!id) continue; // a concurrent lookup created it
          await this.ledger.append(
            { obligationId: id, type: 'CHARGE', amount: p.amount, memo: `rate rule ${p.rateRuleId}`, createdBy: 'system:lazy-obligation' },
            tx,
          );
          n++;
        }
        return n;
      });
    }
    return { payer, stale, createdObligations: created };
  }
}
