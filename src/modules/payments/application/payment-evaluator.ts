import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../../shared/domain/errors';
import type { Minor } from '../../../shared/domain/money';
import type { Db } from '../../../shared/infrastructure/prisma.service';
import { CATALOG_REPOSITORY, type CatalogRepository, type Channel } from '../../catalog/application/catalog.repository';
import { minInstalment } from '../../catalog/domain/instalments';
import { LEDGER_REPOSITORY, type LedgerRepository } from '../../ledger/application/ledger.repository';
import { computePosition, type ObligationPosition } from '../../ledger/domain/position';
import { type FeeSplit, splitFees } from '../domain/fee-split';
import { assertCanInitiate } from '../domain/payment-policy';
import type { LockedObligation } from './payment.repository';

export interface Evaluation {
  position: ObligationPosition;
  minInstalment: Minor;
  split: FeeSplit;
  pricingConfigId: string;
}

/** Shared by quote (no lock) and initiate (under the obligation row lock). */
@Injectable()
export class PaymentEvaluator {
  constructor(
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
    @Inject(CATALOG_REPOSITORY) private readonly catalog: CatalogRepository,
  ) {}

  async evaluate(o: LockedObligation, amount: Minor, channel: Channel, now: Date, db: Db): Promise<Evaluation> {
    const l = (await this.ledger.ledgersFor([o.id], db)).get(o.id)!;
    const position = computePosition(o.amount, l.entries, l.pending, now);
    const ruleMin = o.allowInstalments
      ? await this.catalog.instalmentRuleMin(o.feeId, o.department, db)
      : null;
    const min = minInstalment(
      { allowInstalments: o.allowInstalments, defaultMinInstalment: o.defaultMinInstalment, ruleMinInstalment: ruleMin },
      position.payable,
    );
    assertCanInitiate({ feeTypeCode: o.feeTypeCode, feeActive: o.feeActive, position, minInstalment: min, amount });

    const pricing = await this.catalog.effectivePricing(channel, now, db);
    if (!pricing) throw new DomainError('INVALID_STATE', `No pricing configured for ${channel}`);
    return { position, minInstalment: min, split: splitFees(amount, pricing), pricingConfigId: pricing.id };
  }
}
