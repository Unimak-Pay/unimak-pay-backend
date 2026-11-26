import type { Minor } from '../../../shared/domain/money';
import type { Db } from '../../../shared/infrastructure/prisma.service';
import type { Channel } from '../../catalog/application/catalog.repository';
import type { PaymentStatus } from '../domain/payment-status';

/** PAYMENT_CODE: we create a Monime payment code; USSD_FLOW / DASH_SHEET: the channel collects in-session. */
export type CollectionMethod = 'PAYMENT_CODE' | 'USSD_FLOW' | 'DASH_SHEET';

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
  collectionMethod: CollectionMethod;
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
  /** pay request this payment was made through (dot) */
  payRequestId: string | null;
  /** first name the paying person gave in the dot (display only) */
  paidByName: string | null;
  /** the dot said the payer is paying for themselves (display only) */
  payingForSelf: boolean;
  /** Monime channel.type once completed: bank | card | momo | wallet */
  monimeChannelType: string | null;
  /** Monime's payment.processing_started */
  processingAt: Date | null;
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
  collectionMethod: CollectionMethod;
  pricingConfigId: string;
  monimeFee: Minor;
  platformFee: Minor;
  netAmount: Minor;
  expiresAt: Date;
  payRequestId?: string | null;
  paidByName?: string | null;
  payingForSelf?: boolean;
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
  /** payer's department and level: minimum instalments are per department (optionally per level) */
  department: string | null;
  level: number | null;
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
    patch: Partial<Pick<PaymentRecord, 'status' | 'monimeRef' | 'ussdCode' | 'monimePaymentId' | 'monimeOrderNumber' | 'monimeChannelType' | 'payerPhone' | 'processingAt' | 'completedAt' | 'failureReason'>>,
    db?: Db,
  ): Promise<PaymentRecord>;
  /** PROCESSING with nothing from Monime for PROCESSING_TIMEOUT → back to PENDING. Returns count. */
  resetStaleProcessing(now: Date, db?: Db): Promise<number>;
  /**
   * Permanently deletes payments awaiting payment (INITIATED/PENDING: no ledger entry,
   * receipt or money) that match; returns what was deleted, for the audit log.
   */
  deleteAwaitingPayment(where: { obligationId?: string; exceptId?: string; createdBefore?: Date }, db?: Db): Promise<PaymentRecord[]>;
  obligationInfo(obligationId: string, db?: Db): Promise<LockedObligation | null>;
}
