import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { type Db, PrismaService } from '../../../shared/infrastructure/prisma.service';
import type {
  LockedObligation,
  NewPayment,
  PaymentRecord,
  PaymentRepository,
} from '../application/payment.repository';

const newPaymentRef = (): string => String(randomInt(10_000_000, 100_000_000));

@Injectable()
export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly prisma: PrismaService) {}

  byId(id: string, db: Db = this.prisma): Promise<PaymentRecord | null> {
    return db.payment.findUnique({ where: { id } });
  }

  byMonimeRef(monimeRef: string, db: Db = this.prisma): Promise<PaymentRecord | null> {
    return db.payment.findUnique({ where: { monimeRef } });
  }

  byMonimePaymentId(monimePaymentId: string, db: Db = this.prisma): Promise<PaymentRecord | null> {
    return db.payment.findUnique({ where: { monimePaymentId } });
  }

  byIdempotencyKey(clientId: string, idempotencyKey: string, db: Db = this.prisma): Promise<PaymentRecord | null> {
    return db.payment.findUnique({ where: { clientId_idempotencyKey: { clientId, idempotencyKey } } });
  }

  async lockObligation(obligationId: string, db: Db): Promise<LockedObligation | null> {
    const locked = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Obligation" WHERE id = ${obligationId}::uuid FOR UPDATE`;
    if (locked.length === 0) return null;
    return this.obligationInfo(obligationId, db);
  }

  async lockPayment(id: string, db: Db): Promise<PaymentRecord | null> {
    const locked = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Payment" WHERE id = ${id}::uuid FOR UPDATE`;
    if (locked.length === 0) return null;
    return db.payment.findUnique({ where: { id } });
  }

  async obligationInfo(obligationId: string, db: Db = this.prisma): Promise<LockedObligation | null> {
    const o = await db.obligation.findUnique({
      where: { id: obligationId },
      include: { fee: { include: { feeType: { include: { account: true } } } }, payer: true },
    });
    if (!o) return null;
    return {
      id: o.id,
      amount: o.amount,
      status: o.status,
      feeId: o.feeId,
      feeActive: o.fee.status === 'ACTIVE',
      feeName: o.fee.name,
      feeTypeCode: o.fee.feeType.code,
      settlementAccount: o.fee.feeType.account?.monimeId ?? null,
      allowInstalments: o.fee.allowInstalments,
      defaultMinInstalment: o.fee.defaultMinInstalment,
      payerId: o.payerId,
      payerKind: o.payer.kind,
      payerRef: o.payer.ref,
      payerPortalPhone: o.payer.phone,
      programCode: o.payer.programCode,
      department: o.payer.department,
    };
  }

  async create(p: NewPayment, db: Db): Promise<PaymentRecord> {
    // 9×10^7 refs: check first rather than catch P2002, which would abort the caller's transaction.
    let paymentRef = newPaymentRef();
    for (let i = 0; i < 5 && (await db.payment.findUnique({ where: { paymentRef }, select: { id: true } })); i++) paymentRef = newPaymentRef();
    return db.payment.create({ data: { ...p, paymentRef, status: 'INITIATED' } });
  }

  update(id: string, patch: Partial<PaymentRecord>, db: Db = this.prisma): Promise<PaymentRecord> {
    return db.payment.update({ where: { id }, data: patch });
  }

  async expireDue(now: Date, obligationId?: string, db: Db = this.prisma): Promise<number> {
    const r = await db.payment.updateMany({
      where: {
        status: { in: ['INITIATED', 'PENDING'] },
        expiresAt: { lte: now },
        ...(obligationId ? { obligationId } : {}),
      },
      data: { status: 'EXPIRED', failureReason: 'expired' },
    });
    return r.count;
  }
}
