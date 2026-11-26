import { maskEmail, maskName, maskPhone } from '../../../shared/domain/mask';
import type { DepartmentNames } from '../../academics/application/academics.service';
import { formatSle } from '../../../shared/domain/money';
import type { ObligationView } from '../../payers/application/payer-obligations.query';
import { type Payer, programLine } from '../../payers/domain/payer';
import type { PaymentRecord } from '../../payments/application/payment.repository';
import type { PaymentStatusView } from '../../payments/application/payment-status.query';
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

/**
 * The dot's lookup: full name and academic details, phone masked. Decided with the
 * owner (2026-11-20), replacing the brief's masked-name-only rule for this route.
 */
export function presentDotPayer(p: Payer, stale: boolean, names: DepartmentNames | undefined) {
  return {
    kind: p.kind.toLowerCase(),
    ref: p.ref,
    fullName: p.fullName,
    maskedPhone: p.phone ? maskPhone(p.phone) : null,
    maskedEmail: maskEmail(p.email),
    programCode: p.programCode,
    programLine: programLine(p),
    department: p.department,
    departmentName: names?.departmentName ?? null,
    facultyCode: names?.facultyCode ?? null,
    facultyName: names?.facultyName ?? null,
    level: p.level,
    finalYear: p.finalYear,
    residency: p.residency,
    intake: p.intake,
    applicantStatus: p.applicantStatus,
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

/** Payments don't expire: PENDING until paid or deleted (docs/payment-lifecycle.md). */
export function presentPayment(p: PaymentRecord) {
  const status = p.status;
  return {
    paymentId: p.id,
    /** 8-digit ref to give the payer for status checks */
    paymentRef: p.paymentRef,
    /** Monime order number (in Monime's SMS), once the payment completed */
    monimeOrderNumber: p.monimeOrderNumber,
    obligationId: p.obligationId,
    status,
    amount: money(p.amount),
    channel: p.channel,
    /** when it is deleted if still unpaid (it never expires) */
    expiresAt: p.expiresAt.toISOString(),
    /** what the payer dials to approve (Monime payment code) */
    ussdCode: status === 'PENDING' || status === 'INITIATED' ? p.ussdCode : null,
    completedAt: p.completedAt?.toISOString() ?? null,
    failureReason: status === 'FAILED' ? p.failureReason : null,
  };
}

export function presentPaymentStatus(v: PaymentStatusView) {
  return {
    paymentRef: v.paymentRef,
    monimeOrderNumber: v.monimeOrderNumber,
    status: v.status,
    amount: money(v.amount),
    feeName: v.feeName,
    payer: { kind: v.payerKind.toLowerCase(), ref: v.payerRef, maskedName: v.maskedName },
    receiptNumber: v.receiptNumber,
    createdAt: v.createdAt.toISOString(),
    completedAt: v.completedAt?.toISOString() ?? null,
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

const truncate = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/**
 * What the dot passes to `dash.payments.request()`, built here so the amount and the
 * receiving account never come from the dot. `reference` is our payment id: Monime
 * echoes it (and the metadata) in payment.processing_completed, which settles it.
 */
export function presentDotOrder(p: PaymentRecord, o: { feeName: string; payerRef: string; feeTypeCode: string }, payRequestCode?: string) {
  const value = Number(p.amount);
  if (!Number.isSafeInteger(value)) throw new Error(`Amount ${p.amount} too large for a Dash order`);
  return {
    name: truncate(`UNIMAK ${o.feeName}`, 64),
    reference: p.id,
    lineItems: [{ name: truncate(`${o.feeName} · ${o.payerRef}`, 64), unitPrice: { currency: 'SLE', value }, quantity: 1 }],
    metadata: {
      paymentId: p.id, paymentRef: p.paymentRef, obligationId: p.obligationId, payerRef: o.payerRef, feeTypeCode: o.feeTypeCode, channel: 'DOTS',
      ...(payRequestCode ? { payRequestCode } : {}),
    },
  };
}
