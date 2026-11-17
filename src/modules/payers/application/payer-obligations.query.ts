import { Inject, Injectable } from '@nestjs/common';
import type { Minor } from '../../../shared/domain/money';
import { CATALOG_REPOSITORY, type CatalogRepository } from '../../catalog/application/catalog.repository';
import { minInstalment } from '../../catalog/domain/instalments';
import { LEDGER_REPOSITORY, type LedgerRepository } from '../../ledger/application/ledger.repository';
import { computePosition, type ObligationPosition } from '../../ledger/domain/position';
import type { Payer } from '../domain/payer';
import { PAYER_REPOSITORY, type ObligationRow, type PayerRepository } from './payer.repository';

export interface ObligationView extends ObligationPosition {
  obligation: ObligationRow;
  minInstalment: Minor;
}

@Injectable()
export class PayerObligationsQuery {
  constructor(
    @Inject(PAYER_REPOSITORY) private readonly payers: PayerRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
    @Inject(CATALOG_REPOSITORY) private readonly catalog: CatalogRepository,
  ) {}

  async forPayer(payer: Payer, now = new Date()): Promise<ObligationView[]> {
    const rows = await this.payers.obligationsOf(payer.id);
    const ledgers = await this.ledger.ledgersFor(rows.map((r) => r.id));
    return Promise.all(
      rows.map(async (o) => {
        const l = ledgers.get(o.id) ?? { entries: [], pending: [] };
        const pos = computePosition(o.amount, l.entries, l.pending, now);
        const ruleMin = o.allowInstalments
          ? await this.catalog.instalmentRuleMin(o.feeId, payer.programCode)
          : null;
        return {
          obligation: o,
          ...pos,
          minInstalment: minInstalment(
            { allowInstalments: o.allowInstalments, defaultMinInstalment: o.defaultMinInstalment, ruleMinInstalment: ruleMin },
            pos.payable,
          ),
        };
      }),
    );
  }
}
