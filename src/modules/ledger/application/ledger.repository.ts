import type { Minor } from '../../../shared/domain/money';
import type { Db } from '../../../shared/infrastructure/prisma.service';
import type { HoldLike, LedgerEntryLike, LedgerEntryType } from '../domain/position';

export const LEDGER_REPOSITORY = Symbol('LedgerRepository');

export interface ObligationLedger {
  entries: LedgerEntryLike[];
  pending: HoldLike[];
}

export interface AppendEntry {
  obligationId: string;
  type: LedgerEntryType;
  amount: Minor;
  paymentId?: string;
  memo?: string;
  createdBy: string;
}

export interface LedgerRepository {
  /** Entries and non-final payments for each obligation id. */
  ledgersFor(obligationIds: readonly string[], db?: Db): Promise<Map<string, ObligationLedger>>;
  append(entry: AppendEntry, db: Db): Promise<void>;
}
