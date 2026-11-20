import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DomainError } from '../../../shared/domain/errors';
import type { Minor } from '../../../shared/domain/money';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { AcademicsService } from '../../academics/application/academics.service';
import { AuditService } from '../../audit/audit.service';
import type { AdminPrincipal } from '../../auth/application/admin-principal';
import { SaveRateRuleUseCase } from '../../catalog/application/save-rate-rule.use-case';
import { SetInstalmentRuleUseCase } from '../../catalog/application/set-instalment-rule.use-case';
import { isEligible } from '../../catalog/domain/eligibility';
import type { Matchers } from '../../catalog/domain/matchers';
import type { PayerKind } from '../../catalog/domain/payer-profile';
import { findRateRuleConflicts, resolveRate } from '../../catalog/domain/rate-rule';
import { PayerDirectory } from '../../payers/application/payer-directory';
import { toProfile } from '../../payers/domain/payer';
import { ProvisionAccountsUseCase } from '../../treasury/application/provision-accounts.use-case';

const feeInclude = {
  feeType: { include: { account: true } },
  rateRules: { orderBy: [{ programCode: 'asc' }, { level: 'asc' }, { residency: 'asc' }] },
  eligibilityRules: true,
  instalmentRules: { orderBy: { department: 'asc' } },
  _count: { select: { obligations: true } },
} satisfies Prisma.FeeInclude;

type FeeStatus = 'DRAFT' | 'ACTIVE' | 'CLOSED';
const FEE_TRANSITIONS: Record<FeeStatus, FeeStatus[]> = { DRAFT: ['ACTIVE'], ACTIVE: ['CLOSED'], CLOSED: ['ACTIVE'] };

/**
 * Fee setup for the admin dashboard: fee types (each with its own Monime
 * financial account), fees per year/intake, rate rules, eligibility,
 * minimum instalments and a "what would this payer owe" preview.
 * Every write is audited.
 */
@Injectable()
export class AdminCatalogService {
  private readonly logger = new Logger(AdminCatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly provision: ProvisionAccountsUseCase,
    private readonly rateRules: SaveRateRuleUseCase,
    private readonly setInstalment: SetInstalmentRuleUseCase,
    private readonly directory: PayerDirectory,
    private readonly academics: AcademicsService,
  ) {}

  // ── Fee types (+ their Monime account) ─────────────────────────────────────

  listFeeTypes() {
    return this.prisma.feeType.findMany({ include: { account: true, _count: { select: { fees: true } } }, orderBy: { code: 'asc' } });
  }

  /**
   * Creates the fee type and its Monime financial account. If Monime is
   * unreachable the fee type still exists; POST /fee-types/:id/account retries.
   */
  async createFeeType(admin: AdminPrincipal, input: { code: string; name: string; payerKind: PayerKind; recurrence: 'ONCE' | 'PER_YEAR' }) {
    if (await this.prisma.feeType.findUnique({ where: { code: input.code } })) {
      throw new DomainError('INVALID_STATE', `Fee type ${input.code} already exists`);
    }
    const ft = await this.prisma.$transaction(async (tx) => {
      const row = await tx.feeType.create({ data: input });
      await this.audit.record({ actorId: admin.id, action: 'fee_type.create', entity: 'FeeType', entityId: row.id, after: row }, tx);
      return row;
    });
    let accountError: string | null = null;
    try {
      await this.provision.provisionFeeType(ft.id, admin.id);
    } catch (err) {
      accountError = (err as Error).message;
      this.logger.warn(`Fee type ${ft.code} created but its Monime account failed: ${accountError}`);
    }
    return { ...(await this.prisma.feeType.findUniqueOrThrow({ where: { id: ft.id }, include: { account: true } })), accountError };
  }

  async renameFeeType(admin: AdminPrincipal, id: string, name: string) {
    const before = await this.prisma.feeType.findUnique({ where: { id } });
    if (!before) throw new DomainError('NOT_FOUND', 'Fee type not found');
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.feeType.update({ where: { id }, data: { name } });
      await this.audit.record({ actorId: admin.id, action: 'fee_type.update', entity: 'FeeType', entityId: id, before, after }, tx);
      return after;
    });
  }

  async ensureFeeTypeAccount(admin: AdminPrincipal, id: string) {
    if (!(await this.prisma.feeType.findUnique({ where: { id } }))) throw new DomainError('NOT_FOUND', 'Fee type not found');
    return this.provision.provisionFeeType(id, admin.id);
  }

  // ── Fees ───────────────────────────────────────────────────────────────────

  listFees(q: { feeType?: string; status?: string }) {
    return this.prisma.fee.findMany({
      where: { ...(q.feeType ? { feeType: { code: q.feeType } } : {}), ...(q.status ? { status: q.status as FeeStatus } : {}) },
      include: { feeType: true, _count: { select: { obligations: true, rateRules: true } } },
      orderBy: [{ createdAt: 'desc' }],
    });
  }

  async getFee(id: string) {
    const fee = await this.prisma.fee.findUnique({ where: { id }, include: feeInclude });
    if (!fee) throw new DomainError('NOT_FOUND', 'Fee not found');
    return fee;
  }

  async createFee(admin: AdminPrincipal, input: { feeTypeId: string; name: string; period: string; allowInstalments: boolean; defaultMinInstalment?: Minor; dueDate?: Date }) {
    if (!(await this.prisma.feeType.findUnique({ where: { id: input.feeTypeId } }))) throw new DomainError('NOT_FOUND', 'Fee type not found');
    if (await this.prisma.fee.findUnique({ where: { feeTypeId_period: { feeTypeId: input.feeTypeId, period: input.period } } })) {
      throw new DomainError('INVALID_STATE', `A fee for this type and period ${input.period} already exists`);
    }
    if (!input.allowInstalments && input.defaultMinInstalment !== undefined) throw new DomainError('VALIDATION', 'defaultMinInstalment needs allowInstalments');
    return this.prisma.$transaction(async (tx) => {
      const fee = await tx.fee.create({
        data: { ...input, defaultMinInstalment: input.defaultMinInstalment ?? null, dueDate: input.dueDate ?? null, status: 'DRAFT' },
      });
      await this.audit.record({ actorId: admin.id, action: 'fee.create', entity: 'Fee', entityId: fee.id, after: fee }, tx);
      return fee;
    });
  }

  /** Activating needs ≥ 1 rate rule and the fee type's Monime account. Existing obligations keep their amounts. */
  async updateFee(admin: AdminPrincipal, id: string, patch: { name?: string; allowInstalments?: boolean; defaultMinInstalment?: Minor | null; dueDate?: Date | null; status?: FeeStatus }) {
    const before = await this.getFee(id);
    if (patch.status && patch.status !== before.status) {
      if (!FEE_TRANSITIONS[before.status].includes(patch.status)) throw new DomainError('INVALID_STATE', `Fee cannot go from ${before.status} to ${patch.status}`);
      if (patch.status === 'ACTIVE') {
        if (before.rateRules.length === 0) throw new DomainError('INVALID_STATE', 'Add at least one rate rule before activating');
        if (!before.feeType.account) throw new DomainError('INVALID_STATE', `Fee type ${before.feeType.code} has no Monime financial account yet`);
      }
    }
    const allow = patch.allowInstalments ?? before.allowInstalments;
    const min = patch.defaultMinInstalment === undefined ? before.defaultMinInstalment : patch.defaultMinInstalment;
    if (!allow && min !== null) throw new DomainError('VALIDATION', 'defaultMinInstalment needs allowInstalments');
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.fee.update({ where: { id }, data: patch });
      await this.audit.record({ actorId: admin.id, action: 'fee.update', entity: 'Fee', entityId: id, before: { ...before, rateRules: undefined, eligibilityRules: undefined, instalmentRules: undefined }, after }, tx);
      return after;
    });
  }

  // ── Rate rules ─────────────────────────────────────────────────────────────

  /** Tie rejection on save (domain rule): equal-specificity overlapping rules need a tie-breaker first. */
  async saveRateRule(admin: AdminPrincipal, feeId: string, rule: Matchers & { amount: Minor }, ruleId?: string) {
    await this.getFee(feeId);
    await this.academics.assertUsableDepartments([rule.department]);
    const before = ruleId ? await this.prisma.rateRule.findUnique({ where: { id: ruleId } }) : null;
    if (ruleId && (!before || before.feeId !== feeId)) throw new DomainError('NOT_FOUND', 'Rate rule not found');
    const { id } = await this.rateRules.execute({ feeId, ...rule, ...(ruleId ? { id: ruleId } : {}) });
    const after = await this.prisma.rateRule.findUniqueOrThrow({ where: { id } });
    await this.audit.record({ actorId: admin.id, action: ruleId ? 'rate_rule.update' : 'rate_rule.create', entity: 'RateRule', entityId: id, before, after });
    return after;
  }

  /** Refused if removing it would leave an ambiguous tie (it was a tie-breaker). */
  async deleteRateRule(admin: AdminPrincipal, feeId: string, ruleId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Fee" WHERE id = ${feeId}::uuid FOR UPDATE`;
      const rules = await tx.rateRule.findMany({ where: { feeId } });
      const target = rules.find((r) => r.id === ruleId);
      if (!target) throw new DomainError('NOT_FOUND', 'Rate rule not found');
      const remaining = rules.filter((r) => r.id !== ruleId);
      const conflicts = findRateRuleConflicts(remaining);
      if (conflicts.length) throw new DomainError('AMBIGUOUS_RATE_RULE', 'Deleting this rule would leave equally specific rules tied; delete or change those first');
      const fee = await tx.fee.findUniqueOrThrow({ where: { id: feeId } });
      if (fee.status === 'ACTIVE' && remaining.length === 0) throw new DomainError('INVALID_STATE', 'An active fee needs at least one rate rule');
      await tx.rateRule.delete({ where: { id: ruleId } });
      await this.audit.record({ actorId: admin.id, action: 'rate_rule.delete', entity: 'RateRule', entityId: ruleId, before: target }, tx);
      return { deleted: true };
    });
  }

  // ── Eligibility ────────────────────────────────────────────────────────────

  async addEligibilityRule(admin: AdminPrincipal, feeId: string, rule: Matchers & { finalYear: boolean | null }) {
    await this.getFee(feeId);
    await this.academics.assertUsableDepartments([rule.department]);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.eligibilityRule.create({ data: { feeId, ...rule } });
      await this.audit.record({ actorId: admin.id, action: 'eligibility_rule.create', entity: 'EligibilityRule', entityId: row.id, after: row }, tx);
      return row;
    });
  }

  async deleteEligibilityRule(admin: AdminPrincipal, feeId: string, ruleId: string) {
    const before = await this.prisma.eligibilityRule.findUnique({ where: { id: ruleId } });
    if (!before || before.feeId !== feeId) throw new DomainError('NOT_FOUND', 'Eligibility rule not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.eligibilityRule.delete({ where: { id: ruleId } });
      await this.audit.record({ actorId: admin.id, action: 'eligibility_rule.delete', entity: 'EligibilityRule', entityId: ruleId, before }, tx);
    });
    return { deleted: true };
  }

  // ── Minimum instalments (instalments.manage) ───────────────────────────────

  async setInstalmentRule(admin: AdminPrincipal, feeId: string, department: string, minInstalment: Minor) {
    await this.academics.assertUsableDepartments([department]);
    const before = await this.prisma.instalmentRule.findUnique({ where: { feeId_department: { feeId, department } } });
    await this.setInstalment.execute({ id: admin.id, permissions: [...admin.permissions] }, { feeId, department, minInstalment });
    const after = await this.prisma.instalmentRule.findUniqueOrThrow({ where: { feeId_department: { feeId, department } } });
    await this.audit.record({ actorId: admin.id, action: 'instalment_rule.set', entity: 'InstalmentRule', entityId: after.id, before, after });
    return after;
  }

  async deleteInstalmentRule(admin: AdminPrincipal, feeId: string, department: string) {
    const before = await this.prisma.instalmentRule.findUnique({ where: { feeId_department: { feeId, department } } });
    if (!before) throw new DomainError('NOT_FOUND', 'Instalment rule not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.instalmentRule.delete({ where: { id: before.id } });
      await this.audit.record({ actorId: admin.id, action: 'instalment_rule.delete', entity: 'InstalmentRule', entityId: before.id, before }, tx);
    });
    return { deleted: true };
  }

  // ── Preview ────────────────────────────────────────────────────────────────

  /** What a given payer would owe for this fee, from a live portal lookup. Writes nothing. */
  async preview(feeId: string, kind: PayerKind, ref: string) {
    const fee = await this.getFee(feeId);
    const payer = await this.directory.fetch(kind, ref);
    const profile = toProfile(payer);
    const kindMatches = fee.feeType.payerKind === kind;
    const eligible = kindMatches && isEligible(fee.eligibilityRules, profile);
    let rule = null;
    let ambiguous = false;
    try {
      rule = resolveRate(fee.rateRules, profile);
    } catch {
      ambiguous = true;
    }
    const instalment = fee.allowInstalments ? fee.instalmentRules.find((r) => r.department === payer.department) : undefined;
    return {
      payer: { kind, ref, programCode: payer.programCode, department: payer.department, level: payer.level, residency: payer.residency, intake: payer.intake, finalYear: payer.finalYear },
      fee: { id: fee.id, name: fee.name, status: fee.status, feeType: fee.feeType.code },
      eligible,
      reason: !kindMatches ? `Fee is for ${fee.feeType.payerKind.toLowerCase()}s` : !eligible ? 'No eligibility rule matches' : ambiguous ? 'Rate rules are ambiguous' : !rule ? 'No rate rule matches' : null,
      amount: eligible && rule ? rule.amount : null,
      rateRuleId: rule?.id ?? null,
      minInstalment: !eligible || !rule ? null : !fee.allowInstalments ? rule.amount : (instalment?.minInstalment ?? fee.defaultMinInstalment ?? rule.amount),
    };
  }
}
