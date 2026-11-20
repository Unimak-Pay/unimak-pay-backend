/**
 * Outbox message types and payloads (JSON-safe: money as minor-unit strings).
 * No receipt SMS: Monime texts the payer when a payment completes.
 */
export interface PortalApplicationPaidPayload {
  applicationRef: string;
  receiptNumber: string;
  amount: string;
  paidAt: string;
}

export interface CommissionTransferPayload {
  paymentId: string;
  /** fee type's Monime account (fac-…) */
  fromAccount: string;
  amount: string;
}

export interface OutboxPayloads {
  'portal.application_paid': PortalApplicationPaidPayload;
  'monime.commission_transfer': CommissionTransferPayload;
}

export type OutboxType = keyof OutboxPayloads;

/** Only admins who may see commission transfers see these messages. */
export const COMMISSION_OUTBOX_TYPE = 'monime.commission_transfer' satisfies OutboxType;

export type OutboxMessageInput = {
  [K in OutboxType]: { type: K; dedupeKey: string; payload: OutboxPayloads[K] };
}[OutboxType];
