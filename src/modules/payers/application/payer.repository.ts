import type { Minor } from '../../../shared/domain/money';
import type { Db } from '../../../shared/infrastructure/prisma.service';
import type { PayerKind } from '../../catalog/domain/payer-profile';
import type { Payer, PayerSnapshot } from '../domain/payer';
import type { ExistingObligationRef, PlannedObligation } from '../domain/obligation-planner';

export const PAYER_REPOSITORY = Symbol('PayerRepository');

export interface ObligationRow {
  id: string;
  payerId: string;
  feeId: string;
  feeTypeId: string;
  feeTypeCode: string;
  feeName: string;
  period: string;
  amount: Minor;
  status: 'OPEN' | 'PAID';
  dueDate: Date | null;
  allowInstalments: boolean;
  defaultMinInstalment: Minor | null;
  createdAt: Date;
}

export interface PayerRepository {
  find(kind: PayerKind, ref: string, db?: Db): Promise<Payer | null>;
  /**
   * Saves what the portal said. A lookup (no portalUpdatedAt) never clears an enrolment
   * status or application link an event set; an event (with portalUpdatedAt) sets everything.
   */
  upsertSnapshot(snapshot: PayerSnapshot, at: Date, db?: Db, portalUpdatedAt?: Date): Promise<Payer>;
  existingObligationRefs(payerId: string, db?: Db): Promise<ExistingObligationRef[]>;
  /** Inserts unless (payer, fee) exists; returns the new id or null. */
  insertObligationIfAbsent(payerId: string, plan: PlannedObligation, db: Db): Promise<string | null>;
  obligationsOf(payerId: string, db?: Db): Promise<ObligationRow[]>;
}
