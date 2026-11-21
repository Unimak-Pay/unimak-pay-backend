import { Injectable } from '@nestjs/common';
import type { Payer as PayerRow } from '@prisma/client';
import { type Db, PrismaService } from '../../../shared/infrastructure/prisma.service';
import type { PayerKind } from '../../catalog/domain/payer-profile';
import type { ObligationRow, PayerRepository } from '../application/payer.repository';
import type { ExistingObligationRef, PlannedObligation } from '../domain/obligation-planner';
import type { Payer, PayerSnapshot } from '../domain/payer';

function toPayer(r: PayerRow): Payer {
  return { ...r };
}

@Injectable()
export class PrismaPayerRepository implements PayerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(kind: PayerKind, ref: string, db: Db = this.prisma): Promise<Payer | null> {
    const r = await db.payer.findUnique({ where: { kind_ref: { kind, ref } } });
    return r ? toPayer(r) : null;
  }

  async upsertSnapshot(s: PayerSnapshot, at: Date, db: Db = this.prisma, portalUpdatedAt?: Date): Promise<Payer> {
    const data = { ...s, snapshotAt: at, ...(portalUpdatedAt ? { portalUpdatedAt } : {}) };
    const update = portalUpdatedAt
      ? data
      : {
          ...data,
          ...(s.enrolmentStatus === null ? { enrolmentStatus: undefined } : {}),
          ...(s.applicationRef === null ? { applicationRef: undefined } : {}),
        };
    const r = await db.payer.upsert({
      where: { kind_ref: { kind: s.kind, ref: s.ref } },
      create: data,
      update,
    });
    return toPayer(r);
  }

  async existingObligationRefs(payerId: string, db: Db = this.prisma): Promise<ExistingObligationRef[]> {
    const rows = await db.obligation.findMany({
      where: { payerId },
      select: { feeId: true, fee: { select: { feeTypeId: true } } },
    });
    return rows.map((r) => ({ feeId: r.feeId, feeTypeId: r.fee.feeTypeId }));
  }

  async insertObligationIfAbsent(payerId: string, p: PlannedObligation, db: Db): Promise<string | null> {
    const rows = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO "Obligation" (id, "payerId", "feeId", amount, "rateRuleId", status, "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${payerId}::uuid, ${p.feeId}::uuid, ${p.amount}, ${p.rateRuleId}::uuid, 'OPEN', now(), now())
      ON CONFLICT ("payerId", "feeId") DO NOTHING
      RETURNING id`;
    return rows[0]?.id ?? null;
  }

  async obligationsOf(payerId: string, db: Db = this.prisma): Promise<ObligationRow[]> {
    const rows = await db.obligation.findMany({
      where: { payerId },
      include: { fee: { include: { feeType: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((o) => ({
      id: o.id,
      payerId: o.payerId,
      feeId: o.feeId,
      feeTypeId: o.fee.feeTypeId,
      feeTypeCode: o.fee.feeType.code,
      feeName: o.fee.name,
      period: o.fee.period,
      amount: o.amount,
      status: o.status,
      dueDate: o.fee.dueDate,
      allowInstalments: o.fee.allowInstalments,
      defaultMinInstalment: o.fee.defaultMinInstalment,
      createdAt: o.createdAt,
    }));
  }
}
