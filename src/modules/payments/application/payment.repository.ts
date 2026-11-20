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
  /** 8-digit ref shown to the payer for status checks */
  paymentRef: string;
  /** number that actually paid (full, or Monime's masked one); null until known */
  payerPhone: string | null;
  phoneAuthorized: boolean;
  collectionMethod: 'PAYMENT_CODE' | 'USSD_FLOW';
  status: PaymentStatus;
  monimeRef: string | null;
  ussdCode: string | null;
  monimePaymentId: string | null;
  monimeOrderNumber: string | null;
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
  payerPhone: string | null;
  phoneAuthorized: boolean;
  collectionMethod: 'PAYMENT_CODE' | 'USSD_FLOW';
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
  /** Monime financial account (fac-…); null until provisioned */
  settlementAccount: string | null;
  allowInstalments: boolean;
  defaultMinInstalment: Minor | null;
  payerId: string;
  payerKind: 'APPLICANT' | 'STUDENT';
  payerRef: string;
  /** phone on the portal record */
  payerPortalPhone: string;
  programCode: string;
  /** payer's department: minimum instalments are per department */
  department: string | null;
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
  /** Inserts INITIATED with a fresh unique paymentRef. */
  create(p: NewPayment, db: Db): Promise<PaymentRecord>;
  update(
    id: string,
    patch: Partial<Pick<PaymentRecord, 'status' | 'monimeRef' | 'ussdCode' | 'monimePaymentId' | 'monimeOrderNumber' | 'payerPhone' | 'completedAt' | 'failureReason'>>,
    db?: Db,
  ): Promise<PaymentRecord>;
  /** Marks open payments past expiry as EXPIRED. Returns count. */
  expireDue(now: Date, obligationId?: string, db?: Db): Promise<number>;
  obligationInfo(obligationId: string, db?: Db): Promise<LockedObligation | null>;
}
