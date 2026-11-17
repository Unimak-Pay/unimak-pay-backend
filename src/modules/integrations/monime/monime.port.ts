/**
 * Port to Monime. Shapes here are OUR normalized view; each adapter maps to/from
 * Monime's wire format.
 */
export const MONIME_CLIENT = Symbol('MonimeClient');

export type MonimeChannel = 'USSD' | 'DOTS';
export type MonimePaymentStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';

export interface InitiateCollectionInput {
  /** Our payment id. Also used as the idempotency key towards Monime. */
  reference: string;
  amount: bigint;
  currency: 'SLE';
  payerPhone: string;
  channel: MonimeChannel;
  /** Monime financial account the money settles into (per fee type). */
  settlementAccount: string;
  description: string;
  expiresAt: Date;
  metadata: Record<string, string>;
}

export interface InitiateCollectionResult {
  monimeRef: string;
  status: MonimePaymentStatus;
}

export interface MonimePaymentView {
  monimeRef: string;
  reference: string | null;
  status: MonimePaymentStatus;
  amount: bigint;
}

export interface TransferInput {
  /** Our idempotency key (we use the payment id). */
  idempotencyKey: string;
  fromAccount: string;
  toAccount: string;
  amount: bigint;
  currency: 'SLE';
  description: string;
}

export interface TransferResult {
  transferId: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
}

export type MonimeErrorCode = 'UNAVAILABLE' | 'REJECTED' | 'NOT_FOUND' | 'BAD_RESPONSE';

export class MonimeError extends Error {
  constructor(
    readonly code: MonimeErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MonimeError';
  }
}

export interface MonimeClient {
  initiateCollection(input: InitiateCollectionInput): Promise<InitiateCollectionResult>;
  getPayment(monimeRef: string): Promise<MonimePaymentView>;
  transfer(input: TransferInput): Promise<TransferResult>;
}
