import { formatSle, type Minor } from '../../../shared/domain/money';

export function receiptSmsText(r: {
  amount: Minor;
  feeName: string;
  payerRef: string;
  receiptNumber: string;
  balance: Minor;
  verifyUrl: string;
}): string {
  return (
    `UNIMAK: ${formatSle(r.amount)} received for ${r.feeName} (${r.payerRef}). ` +
    `Receipt ${r.receiptNumber}. Balance ${formatSle(r.balance < 0n ? 0n : r.balance)}. ` +
    `Verify: ${r.verifyUrl}`
  );
}
