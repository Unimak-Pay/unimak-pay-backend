export type SettlementOutcome = 'PROCESSED' | 'IGNORED' | 'UNMATCHED';

/** Outcome of applying one webhook event. */
export interface SettlementResult {
  outcome: SettlementOutcome;
  note?: string;
  paymentId?: string;
  receiptNumber?: string;
  /** outbox messages written; dispatch them after commit */
  outboxKeys: string[];
}
