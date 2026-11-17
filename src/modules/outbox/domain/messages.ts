/** Outbox message types and payloads (JSON-safe: money as minor-unit strings). */
export interface SmsReceiptPayload {
  phone: string;
  text: string;
  receiptNumber: string;
}

export interface PortalApplicationPaidPayload {
  applicationRef: string;
  receiptNumber: string;
  amount: string;
  paidAt: string;
}

export interface CommissionTransferPayload {
  paymentId: string;
  fromAccount: string;
  toAccount: string;
  amount: string;
}

export interface OutboxPayloads {
  'sms.receipt': SmsReceiptPayload;
  'portal.application_paid': PortalApplicationPaidPayload;
  'monime.commission_transfer': CommissionTransferPayload;
}

export type OutboxType = keyof OutboxPayloads;

export type OutboxMessageInput = {
  [K in OutboxType]: { type: K; dedupeKey: string; payload: OutboxPayloads[K] };
}[OutboxType];
