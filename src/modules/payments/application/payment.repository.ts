import type { Minor } from '../../../shared/domain/money';
import type { Db } from '../../../shared/infrastructure/prisma.service';
import type { Channel } from '../../catalog/application/catalog.repository';
import type { PaymentStatus } from '../domain/payment-status';

export const PAYMENT_REPOSITORY = Symbol('PaymentRepository');

export interface PaymentRecord {
  id: string;
  obligationId: string;
  amount: Minor;
  channel: Channel;
  clientId: string;
  idempotencyKey: string;
  payerPhone: string;
  status: PaymentStatus;
  monimeRef: string | null;
  monimePaymentId: string | null;
  pricingConfigId: string;
  monimeFee: Minor;
  platformFee: Minor;
  netAmount: Minor;
  expiresAt: Date;
  completedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
}

export interface NewPayment {
  obligationId: string;
  amount: Minor;
  channel: Channel;
  clientId: string;
  idempotencyKey: string;
  payerPhone: string;
  pricingConfigId: string;
  monimeFee: Minor;
  platformFee: Minor;
  netAmount: Minor;
  expiresAt: Date;
}

/** What initiation needs to know about the obligation, read under the row lock. */
export interface LockedObligation {
  id: string;
  amount: Minor;
  status: 'OPEN' | 'PAID';
  feeId: string;
  feeActive: boolean;
  feeName: string;
  feeTypeCode: string;
  settlementAccount: string;
  allowInstalments: boolean;
  defaultMinInstalment: Minor | null;
  payerId: string;
  payerKind: 'APPLICANT' | 'STUDENT';
  payerRef: string;
  programCode: string;
}

export interface PaymentRepository {
  byId(id: string, db?: Db): Promise<PaymentRecord | null>;
  byMonimeRef(ref: string, db?: Db): Promise<PaymentRecord | null>;
  byMonimePaymentId(id: string, db?: Db): Promise<PaymentRecord | null>;
  byIdempotencyKey(clientId: string, key: string, db?: Db): Promise<PaymentRecord | null>;
  /** SELECT ... FOR UPDATE on the obligation (+ fee/payer info). */
  lockObligation(obligationId: string, db: Db): Promise<LockedObligation | null>;
  /** SELECT ... FOR UPDATE on the payment. */
  lockPayment(id: string, db: Db): Promise<PaymentRecord | null>;
  create(p: NewPayment, db: Db): Promise<PaymentRecord>;
  update(
    id: string,
    patch: Partial<Pick<PaymentRecord, 'status' | 'monimeRef' | 'monimePaymentId' | 'completedAt' | 'failureReason'>>,
    db?: Db,
  ): Promise<PaymentRecord>;
  /** Marks open payments past expiry as EXPIRED. Returns count. */
  expireDue(now: Date, obligationId?: string, db?: Db): Promise<number>;
  obligationInfo(obligationId: string, db?: Db): Promise<LockedObligation | null>;
}
