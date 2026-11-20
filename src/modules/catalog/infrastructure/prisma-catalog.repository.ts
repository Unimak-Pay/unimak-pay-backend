import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { type Db, PrismaService } from '../../../shared/infrastructure/prisma.service';
import type { Minor } from '../../../shared/domain/money';
import type {
  CatalogRepository,
  Channel,
  PricingConfigView,
} from '../application/catalog.repository';
import type { FeeWithRules } from '../domain/fee';
import type { PayerKind } from '../domain/payer-profile';
import type { RateRule } from '../domain/rate-rule';

const feeInclude = {
  feeType: { include: { account: true } },
  rateRules: true,
  eligibilityRules: true,
} satisfies Prisma.FeeInclude;

type FeeRow = Prisma.FeeGetPayload<{ include: typeof feeInclude }>;

function toFee(row: FeeRow): FeeWithRules {
  return {
    id: row.id,
    name: row.name,
    period: row.period,
    allowInstalments: row.allowInstalments,
    defaultMinInstalment: row.defaultMinInstalment,
    dueDate: row.dueDate,
    status: row.status,
    feeType: {
      id: row.feeType.id,
      code: row.feeType.code,
      name: row.feeType.name,
      payerKind: row.feeType.payerKind,
      recurrence: row.feeType.recurrence,
      settlementAccount: row.feeType.account?.monimeId ?? null,
    },
    rateRules: row.rateRules.map(toRateRule),
    eligibilityRules: row.eligibilityRules.map((e) => ({
      programCode: e.programCode,
      department: e.department,
      level: e.level,
      residency: e.residency,
      intake: e.intake,
      finalYear: e.finalYear,
    })),
  };
}

function toRateRule(r: {
  id: string;
  programCode: string | null;
  department: string | null;
  level: number | null;
  residency: 'LOCAL' | 'INTERNATIONAL' | null;
  intake: string | null;
  amount: bigint;
}): RateRule {
  return {
    id: r.id,
    programCode: r.programCode,
    department: r.department,
    level: r.level,
    residency: r.residency,
    intake: r.intake,
    amount: r.amount,
  };
}

@Injectable()
export class PrismaCatalogRepository implements CatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async activeFeesFor(kind: PayerKind, db: Db = this.prisma): Promise<FeeWithRules[]> {
    const rows = await db.fee.findMany({
      where: { status: 'ACTIVE', feeType: { payerKind: kind } },
      include: feeInclude,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toFee);
  }

  async feeById(feeId: string, db: Db = this.prisma): Promise<FeeWithRules | null> {
    const row = await db.fee.findUnique({ where: { id: feeId }, include: feeInclude });
    return row ? toFee(row) : null;
  }

  async lockFeeRateRules(feeId: string, db: Db): Promise<RateRule[]> {
    await db.$queryRaw`SELECT id FROM "Fee" WHERE id = ${feeId}::uuid FOR UPDATE`;
    const rows = await db.rateRule.findMany({ where: { feeId } });
    return rows.map(toRateRule);
  }

  async upsertRateRule(feeId: string, rule: RateRule, db: Db): Promise<void> {
    const data = {
      programCode: rule.programCode,
      department: rule.department,
      level: rule.level,
      residency: rule.residency,
      intake: rule.intake,
      amount: rule.amount,
    };
    await db.rateRule.upsert({
      where: { id: rule.id },
      create: { id: rule.id, feeId, ...data },
      update: data,
    });
  }

  async instalmentRuleMin(
    feeId: string,
    department: string | null,
    db: Db = this.prisma,
  ): Promise<Minor | null> {
    if (!department) return null;
    const row = await db.instalmentRule.findUnique({
      where: { feeId_department: { feeId, department } },
    });
    return row?.minInstalment ?? null;
  }

  async upsertInstalmentRule(
    feeId: string,
    department: string,
    minInstalment: Minor,
    updatedBy: string,
    db: Db = this.prisma,
  ): Promise<void> {
    await db.instalmentRule.upsert({
      where: { feeId_department: { feeId, department } },
      create: { feeId, department, minInstalment, updatedBy },
      update: { minInstalment, updatedBy },
    });
  }

  async effectivePricing(
    channel: Channel,
    at: Date,
    db: Db = this.prisma,
  ): Promise<PricingConfigView | null> {
    return db.pricingConfig.findFirst({
      where: { channel, effectiveFrom: { lte: at } },
      orderBy: { effectiveFrom: 'desc' },
    });
  }
}
