import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppConfig } from '../../../config/app-config';
import { DomainError } from '../../../shared/domain/errors';
import { formatSle } from '../../../shared/domain/money';
import { type Db, PrismaService } from '../../../shared/infrastructure/prisma.service';
import { AuditService } from '../../audit/audit.service';
import type { Payer } from '../../payers/domain/payer';
import { programLine } from '../../payers/domain/payer';
import { type ClearanceRule, evaluateClearance, isPassCode, newPassCode } from '../domain/clearance';

const money = (v: bigint) => ({ value: v.toString(), display: formatSle(v) });
const POLICY_ID = 'current';

export interface ClearancePolicyInput extends ClearanceRule {}

/**
 * Exam clearance, evaluated live from the ledger and the finance office's rule
 * (docs/dot-extras.md §4). A pass only names the student; the public page re-checks
 * clearance every time it is opened, so an old screenshot proves nothing.
 */
@Injectable()
export class ClearanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  async policy(db: Db = this.prisma) {
    const p = await db.clearancePolicy.findUnique({ where: { id: POLICY_ID } });
    if (!p) throw new DomainError('NOT_FOUND', 'Exam clearance is not set up yet');
    return p;
  }

  /** The dot's clearance card (students only). */
  async forPayer(payer: Payer, now = new Date()) {
    if (payer.kind !== 'STUDENT') throw new DomainError('NOT_FOUND', 'Exam clearance is for students');
    const policy = await this.policy();
    const result = await this.evaluate(payer.id, policy, now);
    const pass = result.cleared ? await this.ensurePass(payer.id, policy.period) : null;
    return {
      status: result.cleared ? 'CLEARED' : 'NOT_CLEARED',
      exam: { name: policy.examName, period: policy.period },
      outstanding: money(result.outstanding),
      blocking: result.blocking.map((b) => ({ obligationId: b.obligationId, feeName: b.feeName, balance: money(b.balance) })),
      passCode: pass?.code ?? null,
      verifyUrl: pass ? this.passUrl(pass.code) : null,
      issuedAt: pass?.issuedAt.toISOString() ?? null,
    };
  }

  /** For the public /c/{code} page: is this pass valid right now? */
  async checkPass(code: string, now = new Date()) {
    const c = code.toUpperCase();
    if (!isPassCode(c)) return null;
    const pass = await this.prisma.clearancePass.findUnique({ where: { code: c }, include: { payer: true } });
    if (!pass) return null;
    const policy = await this.policy();
    const samePeriod = pass.period === policy.period;
    const cleared = samePeriod && (await this.evaluate(pass.payerId, policy, now)).cleared;
    return {
      valid: cleared,
      reason: cleared ? null : samePeriod ? 'Fees are outstanding' : `This pass was for ${pass.period}`,
      fullName: pass.payer.fullName,
      ref: pass.payer.ref,
      programLine: programLine(pass.payer),
      examName: policy.examName,
      period: policy.period,
      checkedAt: now,
    };
  }

  /** PUT /v1/admin/clearance-policy: the finance office's rule; no longer a placeholder. */
  async setPolicy(adminId: string, input: ClearancePolicyInput) {
    const codes = [...new Set(input.feeTypeCodes)];
    if (!codes.length && !input.includeOverdue) throw new DomainError('VALIDATION', 'The rule must list fee types or count overdue fees; otherwise everyone is cleared');
    const known = await this.prisma.feeType.findMany({ where: { code: { in: codes } }, select: { code: true } });
    const unknown = codes.filter((c) => !known.some((k) => k.code === c));
    if (unknown.length) throw new DomainError('VALIDATION', `Unknown fee type code(s): ${unknown.join(', ')}`);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.clearancePolicy.findUnique({ where: { id: POLICY_ID } });
      const data = { examName: input.examName.trim(), period: input.period.trim(), feeTypeCodes: codes, includeOverdue: input.includeOverdue, placeholder: false, updatedBy: `admin:${adminId}` };
      const after = await tx.clearancePolicy.upsert({ where: { id: POLICY_ID }, create: { id: POLICY_ID, ...data }, update: data });
      await this.audit.record({ actorId: adminId, action: 'clearance_policy.update', entity: 'ClearancePolicy', entityId: POLICY_ID, before, after }, tx);
      return after;
    });
  }

  private async evaluate(payerId: string, rule: ClearanceRule, now: Date) {
    const obligations = await this.prisma.obligation.findMany({ where: { payerId }, include: { fee: { include: { feeType: true } } } });
    const sums = await this.prisma.ledgerEntry.groupBy({ by: ['obligationId'], where: { obligationId: { in: obligations.map((o) => o.id) } }, _sum: { amount: true } });
    const balance = new Map(sums.map((s) => [s.obligationId, s._sum.amount ?? 0n]));
    return evaluateClearance(rule, obligations.map((o) => ({
      id: o.id, feeName: o.fee.name, feeTypeCode: o.fee.feeType.code, period: o.fee.period, dueDate: o.fee.dueDate, balance: balance.get(o.id) ?? 0n,
    })), now);
  }

  /** One pass per student and period, kept across status changes (the page checks live). */
  private async ensurePass(payerId: string, period: string) {
    const existing = await this.prisma.clearancePass.findUnique({ where: { payerId_period: { payerId, period } } });
    if (existing) return existing;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.clearancePass.create({ data: { payerId, period, code: newPassCode() } });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
        const raced = await this.prisma.clearancePass.findUnique({ where: { payerId_period: { payerId, period } } });
        if (raced) return raced;
        if (attempt >= 4) throw err;
      }
    }
  }

  private passUrl(code: string) {
    return `${this.config.get('PUBLIC_BASE_URL').replace(/\/+$/, '')}/c/${code}`;
  }
}
