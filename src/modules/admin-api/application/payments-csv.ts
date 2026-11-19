import type { Prisma } from '@prisma/client';

export const EXPORT_MAX_ROWS = 50_000;
export const EXPORT_BATCH = 1_000;

type Row = Prisma.PaymentGetPayload<{ include: { obligation: { include: { payer: true; fee: { include: { feeType: true } } } }; receipt: true } }>;

/** Minor units → "1500.00" (SLE). */
export function sle(minor: bigint): string {
  const neg = minor < 0n;
  const v = neg ? -minor : minor;
  return `${neg ? '-' : ''}${v / 100n}.${(v % 100n).toString().padStart(2, '0')}`;
}

/**
 * RFC 4180 cell. Text starting with = + - @ (or tab/CR) is prefixed with ' so
 * a spreadsheet never runs it as a formula (CSV injection).
 */
export function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_COLUMNS = [
  'created_at', 'completed_at', 'payment_ref', 'status', 'channel', 'collection_method',
  'fee_type', 'fee_name', 'payer_kind', 'payer_ref', 'payer_name', 'program', 'department',
  'amount_sle', 'monime_fee_sle', 'platform_fee_sle', 'net_sle',
  'payer_phone', 'monime_order_number', 'monime_payment_id', 'receipt_number', 'failure_reason', 'payment_id',
] as const;

export function csvRow(p: Row): string {
  const o = p.obligation;
  return [
    p.createdAt.toISOString(), p.completedAt?.toISOString() ?? null, p.paymentRef, p.status, p.channel, p.collectionMethod,
    o.fee.feeType.code, o.fee.name, o.payer.kind, o.payer.ref, o.payer.fullName, o.payer.programCode, o.payer.department,
    sle(p.amount), sle(p.monimeFee), sle(p.platformFee), sle(p.netAmount),
    p.payerPhone, p.monimeOrderNumber, p.monimePaymentId, p.receipt?.number ?? null, p.failureReason, p.id,
  ].map(cell).join(',');
}
