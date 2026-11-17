import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';

export interface ReceiptView {
  number: string;
  verifyCode: string;
  amount: bigint;
  issuedAt: Date;
  paymentId: string;
  channel: string;
  feeName: string;
  period: string;
  payerKind: 'APPLICANT' | 'STUDENT';
  payerRef: string;
  payerName: string;
  payerPhone: string;
}

const include = {
  payment: { select: { channel: true } },
  payer: true,
  obligation: { include: { fee: true } },
} as const;

@Injectable()
export class ReceiptsQuery {
  constructor(private readonly prisma: PrismaService) {}

  async forPayer(payerId: string): Promise<ReceiptView[]> {
    const rows = await this.prisma.receipt.findMany({ where: { payerId }, include, orderBy: { issuedAt: 'desc' } });
    return rows.map(toView);
  }

  async byNumber(number: string): Promise<ReceiptView | null> {
    const r = await this.prisma.receipt.findUnique({ where: { number }, include });
    return r ? toView(r) : null;
  }

  async byVerifyCode(verifyCode: string): Promise<ReceiptView | null> {
    const r = await this.prisma.receipt.findUnique({ where: { verifyCode }, include });
    return r ? toView(r) : null;
  }
}

function toView(r: {
  number: string; verifyCode: string; amount: bigint; issuedAt: Date; paymentId: string;
  payment: { channel: string };
  payer: { kind: 'APPLICANT' | 'STUDENT'; ref: string; fullName: string; phone: string };
  obligation: { fee: { name: string; period: string } };
}): ReceiptView {
  return {
    number: r.number,
    verifyCode: r.verifyCode,
    amount: r.amount,
    issuedAt: r.issuedAt,
    paymentId: r.paymentId,
    channel: r.payment.channel,
    feeName: r.obligation.fee.name,
    period: r.obligation.fee.period,
    payerKind: r.payer.kind,
    payerRef: r.payer.ref,
    payerName: r.payer.fullName,
    payerPhone: r.payer.phone,
  };
}
