import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../../shared/domain/errors';
import type { Minor } from '../../../shared/domain/money';
import { type Db, PrismaService } from '../../../shared/infrastructure/prisma.service';
import { AuditService } from '../../audit/audit.service';
import type { AdminPrincipal } from '../../auth/application/admin-principal';
import { LEDGER_REPOSITORY, type LedgerRepository } from '../../ledger/application/ledger.repository';
import { decideReprice, type RepriceSkipReason } from '../../payers/domain/reprice';

interface PayerRef { kind: string; ref: string; fullName: string }

export interface RepriceReport {
  fee: { id: string; name: string };
  applied: boolean;
  changes: { obligationId: string; payer: PayerRef; current: Minor; proposed: Minor; difference: Minor; rateRuleId: string }[];
  skipped: { obligationId: string; payer: PayerRef; current: Minor; reason: RepriceSkipReason }[];
  unchanged: number;
  totals: { obligations: number; changed: number; difference: Minor };
}

/**
 * Re-price a fee's existing obligations after its rate rules changed. Preview has no
 * writes; apply locks the fee and its obligations, decides again, and for each change
 * appends an ADJUSTMENT ledger entry (the ledger is append-only) and moves the
 * obligation's amount and rate rule. Obligations with payments are only reported.
 */
@Injectable()
export class AdminRepriceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
  ) {}

  preview(feeId: string, now = new Date()): Promise<RepriceReport> {
    return this.plan(this.prisma, feeId, now);
  }

  async apply(admin: AdminPrincipal, feeId: string, now = new Date()): Promise<RepriceReport> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Fee" WHERE id = ${feeId}::uuid FOR UPDATE`;
        // same lock order as starting a payment (obligation row), so neither waits on a stale view
        await tx.$queryRaw`SELECT id FROM "Obligation" WHERE "feeId" = ${feeId}::uuid ORDER BY id FOR UPDATE`;
        const report = await this.plan(tx, feeId, now);
        for (const c of report.changes) {
          await this.ledger.append(
            { obligationId: c.obligationId, type: 'ADJUSTMENT', amount: c.difference, memo: `reprice: ${c.current} → ${c.proposed} (rate rule ${c.rateRuleId})`, createdBy: `admin:${admin.id}` },
            tx,
          );
          await tx.obligation.update({ where: { id: c.obligationId }, data: { amount: c.proposed, rateRuleId: c.rateRuleId } });
        }
        await this.audit.record(
          {
            actorId: admin.id, action: 'fee.reprice', entity: 'Fee', entityId: feeId,
            after: {
              changed: report.changes.map((c) => ({ obligationId: c.obligationId, payer: c.payer.ref, from: c.current.toString(), to: c.proposed.toString() })),
              skipped: report.skipped.map((s) => ({ obligationId: s.obligationId, payer: s.payer.ref, reason: s.reason })),
              difference: report.totals.difference.toString(),
            },
          },
          tx,
        );
        return { ...report, applied: true };
      },
      { timeout: 60_000 },
    );
  }

  private async plan(db: Db, feeId: string, now: Date): Promise<RepriceReport> {
    const fee = await db.fee.findUnique({ where: { id: feeId }, include: { rateRules: true, eligibilityRules: true } });
    if (!fee) throw new DomainError('NOT_FOUND', 'Fee not found');
    if (fee.status === 'DRAFT') throw new DomainError('INVALID_STATE', 'A draft fee has no obligations to re-price');
    const obligations = await db.obligation.findMany({
      where: { feeId },
      orderBy: { createdAt: 'asc' },
      include: {
        payer: true,
        entries: { select: { type: true } },
        payments: { where: { status: { in: ['INITIATED', 'PENDING'] } }, select: { status: true, expiresAt: true } },
      },
    });

    const report: RepriceReport = {
      fee: { id: fee.id, name: fee.name }, applied: false, changes: [], skipped: [], unchanged: 0,
      totals: { obligations: obligations.length, changed: 0, difference: 0n },
    };
    for (const o of obligations) {
      const payer = { kind: o.payer.kind.toLowerCase(), ref: o.payer.ref, fullName: o.payer.fullName };
      const d = decideReprice(
        {
          status: o.status, amount: o.amount, entryTypes: o.entries.map((e) => e.type), openPayments: o.payments,
          profile: {
            kind: o.payer.kind, programCode: o.payer.programCode, department: o.payer.department, level: o.payer.level,
            residency: o.payer.residency, intake: o.payer.intake, finalYear: o.payer.finalYear,
          },
        },
        fee,
        now,
      );
      if (d.kind === 'UNCHANGED') report.unchanged++;
      else if (d.kind === 'SKIP') report.skipped.push({ obligationId: o.id, payer, current: o.amount, reason: d.reason });
      else {
        report.changes.push({ obligationId: o.id, payer, current: o.amount, proposed: d.proposed, difference: d.difference, rateRuleId: d.rateRuleId });
        report.totals.changed++;
        report.totals.difference += d.difference;
      }
    }
    return report;
  }
}
