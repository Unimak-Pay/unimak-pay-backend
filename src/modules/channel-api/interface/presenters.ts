import { maskName } from '../../../shared/domain/mask';
import { formatSle } from '../../../shared/domain/money';
import type { ObligationView } from '../../payers/application/payer-obligations.query';
import { type Payer, programLine } from '../../payers/domain/payer';
import type { PaymentRecord } from '../../payments/application/payment.repository';
import type { ReceiptView } from '../../receipts/application/receipts.query';

const money = (v: bigint) => ({ value: v.toString(), display: formatSle(v) });

export function presentPayer(p: Payer, stale: boolean) {
  return {
    kind: p.kind.toLowerCase(),
    ref: p.ref,
    maskedName: maskName(p.fullName),
    programLine: programLine(p),
    stale,
  };
}

export function presentObligation(v: ObligationView) {
  const o = v.obligation;
  return {
    id: o.id,
    feeTypeCode: o.feeTypeCode,
    feeName: o.feeName,
    period: o.period,
    amount: money(v.amount),
    paid: money(v.paid),
    balance: money(v.balance),
    holds: money(v.holds),
    payable: money(v.payable),
    minInstalment: money(v.minInstalment),
    allowInstalments: o.allowInstalments,
    dueDate: o.dueDate?.toISOString().slice(0, 10) ?? null,
    status: o.status,
  };
}

/** Expired-by-time payments read as EXPIRED even before the sweep runs. */
export function presentPayment(p: PaymentRecord, now = new Date()) {
  const status = (p.status === 'INITIATED' || p.status === 'PENDING') && p.expiresAt <= now ? 'EXPIRED' : p.status;
  return {
    paymentId: p.id,
    obligationId: p.obligationId,
    status,
    amount: money(p.amount),
    channel: p.channel,
    expiresAt: p.expiresAt.toISOString(),
    /** what the payer dials to approve (Monime payment code) */
    ussdCode: status === 'PENDING' ? p.ussdCode : null,
    completedAt: p.completedAt?.toISOString() ?? null,
    failureReason: status === 'FAILED' ? p.failureReason : null,
  };
}

export function presentReceipt(r: ReceiptView) {
  return {
    number: r.number,
    amount: money(r.amount),
    feeName: r.feeName,
    period: r.period,
    channel: r.channel,
    issuedAt: r.issuedAt.toISOString(),
    paymentId: r.paymentId,
  };
}
