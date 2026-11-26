import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import { formatSle } from '../../../shared/domain/money';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import type { Payer } from '../../payers/domain/payer';
import { programLine } from '../../payers/domain/payer';
import { PAYMENT_REF } from '../../payments/domain/payment-ref';
import { academicYearOf, paymentMethodLabel, shownInHistory } from '../domain/history';

const money = (v: bigint) => ({ value: v.toString(), display: formatSle(v) });

/** History and receipts read COMPLETED only as Monime confirmed it; nothing the dot sent decides it. */
@Injectable()
export class PaymentHistoryQuery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  async forPayer(payer: Payer, now = new Date()) {
    const [payments, obligations] = await Promise.all([
      this.prisma.payment.findMany({
        where: { obligation: { payerId: payer.id } },
        include: { obligation: { include: { fee: true } }, receipt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
      this.prisma.obligation.findMany({ where: { payerId: payer.id }, select: { fee: { select: { period: true } } } }),
    ]);
    const academicYear = academicYearOf(obligations.map((o) => o.fee.period));
    const totalPaid = payments
      .filter((p) => p.status === 'COMPLETED' && p.obligation.fee.period === academicYear)
      .reduce((s, p) => s + p.amount, 0n);
    return {
      academicYear,
      totalPaid: money(totalPaid),
      payments: payments.filter((p) => shownInHistory(p, now)).map((p) => ({
        paymentRef: p.paymentRef,
        obligationId: p.obligationId,
        feeName: p.obligation.fee.name,
        period: p.obligation.fee.period,
        amount: money(p.amount),
        status: p.status,
        paidBy: { name: p.paidByName, self: p.payingForSelf },
        method: paymentMethodLabel(p.monimeChannelType),
        receiptNumber: p.status === 'COMPLETED' ? (p.receipt?.number ?? null) : null,
        createdAt: p.createdAt.toISOString(),
        completedAt: p.completedAt?.toISOString() ?? null,
      })),
    };
  }

  /** By our 8-digit payment ref; null until the payment is COMPLETED with its receipt. */
  async receipt(paymentRef: string) {
    if (!PAYMENT_REF.test(paymentRef)) return null;
    const p = await this.prisma.payment.findUnique({
      where: { paymentRef },
      include: { obligation: { include: { fee: true, payer: true } }, receipt: true },
    });
    if (!p || p.status !== 'COMPLETED' || !p.receipt) return null;
    const payer = p.obligation.payer;
    return {
      receiptNumber: p.receipt.number,
      paymentRef: p.paymentRef,
      amount: money(p.receipt.amount),
      feeName: p.obligation.fee.name,
      period: p.obligation.fee.period,
      payer: { kind: payer.kind === 'STUDENT' ? 'student' : 'applicant', ref: payer.ref, fullName: payer.fullName, programLine: programLine(payer) },
      paidBy: { name: p.paidByName, self: p.payingForSelf },
      method: paymentMethodLabel(p.monimeChannelType),
      issuedAt: p.receipt.issuedAt.toISOString(),
      verifyUrl: `${this.config.get('PUBLIC_BASE_URL').replace(/\/+$/, '')}/r/${p.receipt.verifyCode}`,
      /** PDFs come later (they need a PDF library); the dot falls back to an image */
      pdfUrl: null,
    };
  }
}
