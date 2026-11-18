/**
 * Idempotent seed: fee types, 2026/27 fees with rate/eligibility/instalment rules,
 * and channel pricing. Amounts are SLE minor units (1 SLE = 100).
 *
 *   pnpm db:seed
 */
import { type Prisma, PrismaClient } from '@prisma/client';
import { findRateRuleConflicts, type RateRule } from '../src/modules/catalog/domain/rate-rule';

const prisma = new PrismaClient();
const SLE = (n: number): bigint => BigInt(Math.round(n * 100));

const FEE_TYPES = [
  { code: 'APP', name: 'Application fee', payerKind: 'APPLICANT', recurrence: 'ONCE' },
  { code: 'MATRIC', name: 'Matriculation fee', payerKind: 'STUDENT', recurrence: 'ONCE' },
  { code: 'TUITION', name: 'Tuition', payerKind: 'STUDENT', recurrence: 'PER_YEAR' },
  { code: 'DEPT', name: 'Departmental fee', payerKind: 'STUDENT', recurrence: 'PER_YEAR' },
  { code: 'GRAD', name: 'Graduation fee', payerKind: 'STUDENT', recurrence: 'ONCE' },
] as const satisfies readonly Omit<Prisma.FeeTypeCreateInput, 'fees'>[];

type Rule = Omit<RateRule, 'id'>;
const rule = (amount: bigint, m: Partial<Rule> = {}): Rule => ({
  programCode: null, department: null, level: null, residency: null, intake: null, amount, ...m,
});

/** Tuition 2026/27: program × level × residency. International = 2× local. */
const TUITION_BASE: Record<string, { base: number; step: number }> = {
  'BSC-CS': { base: 6_000, step: 200 },
  'BSC-IT': { base: 5_500, step: 200 },
  'BSC-NUR': { base: 7_000, step: 250 },
};
const tuitionRules: Rule[] = Object.entries(TUITION_BASE).flatMap(([programCode, { base, step }]) =>
  [1, 2, 3, 4].flatMap((level) => [
    rule(SLE(base + step * (level - 1)), { programCode, level, residency: 'LOCAL' }),
    rule(SLE((base + step * (level - 1)) * 2), { programCode, level, residency: 'INTERNATIONAL' }),
  ]),
);

interface FeeSeed {
  typeCode: (typeof FEE_TYPES)[number]['code'];
  name: string;
  period: string;
  allowInstalments: boolean;
  defaultMinInstalment: bigint | null;
  dueDate: Date | null;
  rateRules: Rule[];
  eligibility: Omit<Prisma.EligibilityRuleCreateManyInput, 'feeId'>[];
  instalmentRules: { programCode: string; minInstalment: bigint }[];
}

const FEES: FeeSeed[] = [
  {
    typeCode: 'APP', name: 'Application fee 2026-SEP', period: '2026-SEP',
    allowInstalments: false, defaultMinInstalment: null, dueDate: new Date('2026-08-31'),
    rateRules: [rule(SLE(150)), rule(SLE(500), { residency: 'INTERNATIONAL' })],
    eligibility: [{ intake: '2026-SEP' }],
    instalmentRules: [],
  },
  {
    typeCode: 'TUITION', name: 'Tuition 2026/27', period: '2026/27',
    allowInstalments: true, defaultMinInstalment: SLE(1_000), dueDate: new Date('2027-01-31'),
    rateRules: tuitionRules,
    eligibility: [],
    instalmentRules: [
      { programCode: 'BSC-NUR', minInstalment: SLE(2_000) },
      { programCode: 'BSC-CS', minInstalment: SLE(1_500) },
    ],
  },
  {
    typeCode: 'MATRIC', name: 'Matriculation 2026-SEP', period: '2026-SEP',
    allowInstalments: false, defaultMinInstalment: null, dueDate: new Date('2026-10-31'),
    rateRules: [rule(SLE(250))],
    eligibility: [{ intake: '2026-SEP' }],
    instalmentRules: [],
  },
  {
    typeCode: 'DEPT', name: 'Computing departmental fee 2026/27', period: '2026/27',
    allowInstalments: false, defaultMinInstalment: null, dueDate: new Date('2026-12-15'),
    rateRules: [rule(SLE(300), { department: 'COMPUTING' })],
    eligibility: [{ department: 'COMPUTING' }],
    instalmentRules: [],
  },
  {
    typeCode: 'GRAD', name: 'Graduation 2026/27', period: '2026/27',
    allowInstalments: false, defaultMinInstalment: null, dueDate: new Date('2027-05-31'),
    rateRules: [rule(SLE(750))],
    eligibility: [{ finalYear: true }],
    instalmentRules: [],
  },
];

const PRICING = [
  // USSD: Monime 1%, platform 1.5% (of a 2.5% total)
  { channel: 'USSD', totalRateBps: 250, monimeRateBps: 100, monimeFlat: 0n, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
  // DOTS: Monime SLE 0.50 flat, platform 2.5% − 0.50 (≥ 0)
  { channel: 'DOTS', totalRateBps: 250, monimeRateBps: 0, monimeFlat: SLE(0.5), effectiveFrom: new Date('2026-01-01T00:00:00Z') },
] as const;

async function main(): Promise<void> {
  for (const f of FEES) {
    const conflicts = findRateRuleConflicts(f.rateRules.map((r, i) => ({ ...r, id: `${f.typeCode}-${i}` })));
    if (conflicts.length) throw new Error(`Seed rate rules for ${f.name} are ambiguous`);
  }

  await prisma.$transaction(async (tx) => {
    const types = new Map<string, string>();
    for (const t of FEE_TYPES) {
      const row = await tx.feeType.upsert({ where: { code: t.code }, create: t, update: t });
      types.set(t.code, row.id);
    }

    for (const f of FEES) {
      const feeTypeId = types.get(f.typeCode)!;
      const existing = await tx.fee.findUnique({ where: { feeTypeId_period: { feeTypeId, period: f.period } } });
      if (existing) {
        console.log(`  = ${f.name} (exists, rules untouched)`);
        continue;
      }
      const fee = await tx.fee.create({
        data: {
          feeTypeId, name: f.name, period: f.period, status: 'ACTIVE',
          allowInstalments: f.allowInstalments, defaultMinInstalment: f.defaultMinInstalment, dueDate: f.dueDate,
        },
      });
      await tx.rateRule.createMany({ data: f.rateRules.map((r) => ({ ...r, feeId: fee.id })) });
      if (f.eligibility.length) await tx.eligibilityRule.createMany({ data: f.eligibility.map((e) => ({ ...e, feeId: fee.id })) });
      for (const ir of f.instalmentRules) {
        await tx.instalmentRule.create({ data: { ...ir, feeId: fee.id, updatedBy: 'seed' } });
      }
      console.log(`  + ${f.name}: ${f.rateRules.length} rate rules`);
    }

    for (const p of PRICING) {
      await tx.pricingConfig.upsert({
        where: { channel_effectiveFrom: { channel: p.channel, effectiveFrom: p.effectiveFrom } },
        create: p,
        update: p,
      });
    }
  }, { timeout: 60_000, maxWait: 10_000 }); // many round trips to a remote DB
  console.log('Seed complete.');
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
