import type { Db } from '../../../shared/infrastructure/prisma.service';
import type { Minor } from '../../../shared/domain/money';
import type { FeeWithRules } from '../domain/fee';
import type { PayerKind } from '../domain/payer-profile';
import type { RateRule } from '../domain/rate-rule';

export type Channel = 'USSD' | 'DOTS';

export interface PricingConfigView {
  id: string;
  channel: Channel;
  totalRateBps: number;
  monimeRateBps: number;
  monimeFlat: Minor;
  effectiveFrom: Date;
}

export const CATALOG_REPOSITORY = Symbol('CatalogRepository');

export interface CatalogRepository {
  activeFeesFor(kind: PayerKind, db?: Db): Promise<FeeWithRules[]>;
  feeById(feeId: string, db?: Db): Promise<FeeWithRules | null>;
  /** Locks the fee row so concurrent rule edits on the same fee serialize. */
  lockFeeRateRules(feeId: string, db: Db): Promise<RateRule[]>;
  upsertRateRule(feeId: string, rule: RateRule, db: Db): Promise<void>;
  /** Minimum instalment for the payer's department at their level (else all levels), if set. */
  instalmentRuleMin(feeId: string, department: string | null, level: number | null, db?: Db): Promise<Minor | null>;
  /** One rule per (fee, department, level); level null = every level. Locks the fee row. */
  upsertInstalmentRule(
    feeId: string,
    department: string,
    level: number | null,
    minInstalment: Minor,
    updatedBy: string,
    db?: Db,
  ): Promise<void>;
  effectivePricing(channel: Channel, at: Date, db?: Db): Promise<PricingConfigView | null>;
}
