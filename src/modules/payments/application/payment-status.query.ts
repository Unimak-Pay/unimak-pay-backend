import { Injectable } from '@nestjs/common';
import { maskName, shortName } from '../../../shared/domain/mask';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { MONIME_ORDER_NUMBER, normalizePublicRef, PAYMENT_REF } from '../domain/payment-ref';
import type { PaymentStatus } from '../domain/payment-status';

/** What a payer may see about a payment, found by our ref or Monime's order number. */
export interface PaymentStatusView {
  paymentRef: string;
  monimeOrderNumber: string | null;
  status: PaymentStatus;
  amount: bigint;
  feeName: string;
  payerKind: 'APPLICANT' | 'STUDENT';
  payerRef: string;
  maskedName: string;
  /** "Aminata K." — USSD screens only */
  shortName: string;
  receiptNumber: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

@Injectable()
export class PaymentStatusQuery {
  constructor(private readonly prisma: PrismaService) {}

  /** ref: our 8-digit payment ref or Monime's order number, as typed (case/spaces/dashes ignored). */
  async byPublicRef(raw: string): Promise<PaymentStatusView | null> {
    const ref = normalizePublicRef(raw);
    if (!ref) return null;
    const include = { obligation: { include: { payer: true, fee: true } }, receipt: true } as const;
    const p = PAYMENT_REF.test(ref)
      ? await this.prisma.payment.findUnique({ where: { paymentRef: ref }, include })
      : MONIME_ORDER_NUMBER.test(ref)
        ? await this.prisma.payment.findFirst({ where: { monimeOrderNumber: ref }, orderBy: { createdAt: 'desc' }, include })
        : null;
    if (!p) return null;
    return {
      paymentRef: p.paymentRef,
      monimeOrderNumber: p.monimeOrderNumber,
      status: p.status,
      amount: p.amount,
      feeName: p.obligation.fee.name,
      payerKind: p.obligation.payer.kind,
      payerRef: p.obligation.payer.ref,
      maskedName: maskName(p.obligation.payer.fullName),
      shortName: shortName(p.obligation.payer.fullName),
      receiptNumber: p.receipt?.number ?? null,
      createdAt: p.createdAt,
      completedAt: p.completedAt,
    };
  }
}
