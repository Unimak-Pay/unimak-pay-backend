import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Db } from '../../../shared/infrastructure/prisma.service';
import { CATALOG_REPOSITORY, type CatalogRepository } from '../../catalog/application/catalog.repository';
import { LEDGER_REPOSITORY, type LedgerRepository } from '../../ledger/application/ledger.repository';
import { planObligations } from '../domain/obligation-planner';
import { canBeCharged, type Payer, toProfile } from '../domain/payer';
import { PAYER_REPOSITORY, type PayerRepository } from './payer.repository';

/**
 * Creates the obligations a payer is missing (each with its CHARGE entry), inside the
 * caller's transaction. Used by lookups and by portal events. Students the portal says
 * aren't active get nothing new; what they already owe is untouched.
 */
@Injectable()
export class ObligationSync {
  private readonly logger = new Logger(ObligationSync.name);

  constructor(
    @Inject(PAYER_REPOSITORY) private readonly payers: PayerRepository,
    @Inject(CATALOG_REPOSITORY) private readonly catalog: CatalogRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
  ) {}

  async ensure(payer: Payer, db: Db, createdBy = 'system:lazy-obligation'): Promise<number> {
    if (!canBeCharged(payer)) return 0;
    const [fees, existing] = await Promise.all([this.catalog.activeFeesFor(payer.kind, db), this.payers.existingObligationRefs(payer.id, db)]);
    const plan = planObligations(toProfile(payer), fees, existing);
    for (const s of plan.skipped) {
      this.logger.warn(`Payer ${payer.kind} ${payer.ref} eligible for fee ${s.feeId} but ${s.reason}`);
    }
    let created = 0;
    for (const p of plan.create) {
      const id = await this.payers.insertObligationIfAbsent(payer.id, p, db);
      if (!id) continue; // created concurrently
      await this.ledger.append({ obligationId: id, type: 'CHARGE', amount: p.amount, memo: `rate rule ${p.rateRuleId}`, createdBy }, db);
      created++;
    }
    return created;
  }
}
