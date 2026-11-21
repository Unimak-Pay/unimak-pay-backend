import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError } from '../../../shared/domain/errors';
import { maskPhone } from '../../../shared/domain/mask';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { minInstalment, pickInstalmentRule } from '../../catalog/domain/instalments';
import { collectionRate, standing, sumTotals, type CellTotals, type StandingFilter } from '../../payers/domain/standing';
import { AuditService } from '../../audit/audit.service';
import type { AdminPrincipal } from '../../auth/application/admin-principal';
import { cell, EXPORT_BATCH, EXPORT_MAX_ROWS, sle } from './payments-csv';

/** Which fees count: one fee, or a fee type and/or period. None = every fee. */
export interface FeeFilters { feeId?: string; feeType?: string; period?: string }

/** Which payers count. Department-scoped admins are always limited to their departments on top. */
export interface PayerFilters extends FeeFilters {
  kind?: 'STUDENT' | 'APPLICANT';
  department?: string;
  /** Faculty.code: its departments as they are now */
  faculty?: string;
  level?: number;
  enrolmentStatus?: 'ACTIVE' | 'SUSPENDED' | 'WITHDRAWN' | 'GRADUATED';
  /** suspended, withdrawn and graduated students are left out unless asked for (they're in Needs review) */
  includeInactive?: boolean;
  /** ref or name contains */
  q?: string;
}

export const PAYER_SORTS = ['-balance', 'balance', 'name', 'ref'] as const;
export type PayerSort = (typeof PAYER_SORTS)[number];

export interface PayerListQuery extends PayerFilters { standing?: StandingFilter; sort?: PayerSort; limit: number; cursor?: string }

interface PayerRow {
  id: string; kind: 'STUDENT' | 'APPLICANT'; ref: string; fullName: string; phone: string; programCode: string;
  department: string | null; departmentName: string | null; facultyCode: string | null; level: number | null;
  enrolmentStatus: string | null; applicantStatus: string | null;
  obligations: number; billed: bigint; collected: bigint; outstanding: bigint; overdueAmount: bigint; lastPaymentAt: Date | null;
}

type CellRow = CellTotals & { department: string | null; departmentName: string | null; facultyCode: string | null; facultyName: string | null; level: number | null };

const ACTIVE_ONLY = Prisma.sql`(py."enrolmentStatus" IS NULL OR py."enrolmentStatus" = 'ACTIVE')`;
/** SQL twin of standing() in payers/domain/standing.ts, for filtering. */
const STANDING_SQL = Prisma.sql`CASE WHEN pp.obligations = 0 THEN 'NOT_BILLED' WHEN pp.outstanding <= 0 THEN 'PAID' WHEN pp.collected > 0 THEN 'PART_PAID' ELSE 'UNPAID' END`;
const and = (parts: (Prisma.Sql | null | undefined | false)[]) => Prisma.join([Prisma.sql`TRUE`, ...parts.filter((x): x is Prisma.Sql => !!x)], ' AND ');
const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Billed / collected / outstanding by department and level, the payer list
 * behind it, its CSV, and one payer's full picture (docs/analytics.md).
 * Everything is computed live from obligations and the ledger.
 */
@Injectable()
export class AdminAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── SQL building blocks ────────────────────────────────────────────────────

  private feeWhere(f: FeeFilters): Prisma.Sql {
    return and([
      f.feeId ? Prisma.sql`f.id = ${f.feeId}::uuid` : null,
      f.feeType ? Prisma.sql`ft.code = ${f.feeType}` : null,
      f.period ? Prisma.sql`f.period = ${f.period}` : null,
    ]);
  }

  private payerWhere(admin: AdminPrincipal, f: PayerFilters): Prisma.Sql {
    const students = f.kind !== 'APPLICANT';
    return and([
      f.kind ? Prisma.sql`py.kind = ${f.kind}::"PayerKind"` : null,
      f.department ? Prisma.sql`py.department = ${f.department}` : null,
      f.faculty ? Prisma.sql`py.department IN (SELECT d2.code FROM "Department" d2 JOIN "Faculty" f2 ON f2.id = d2."facultyId" WHERE f2.code = ${f.faculty})` : null,
      f.level !== undefined ? Prisma.sql`py.level = ${f.level}` : null,
      f.enrolmentStatus ? Prisma.sql`py."enrolmentStatus" = ${f.enrolmentStatus}::"EnrolmentStatus"` : null,
      students && !f.enrolmentStatus && !f.includeInactive ? Prisma.sql`(py.kind = 'APPLICANT' OR ${ACTIVE_ONLY})` : null,
      f.q ? Prisma.sql`(py.ref ILIKE ${like(f.q)} OR py."fullName" ILIKE ${like(f.q)})` : null,
      admin.departmentScoped ? Prisma.sql`py.department IN (${Prisma.join(admin.departments.length ? [...admin.departments] : [''])})` : null,
    ]);
  }

  /**
   * `ob`: each obligation of the selected fees with billed / collected / balance.
   * `pp`: each selected payer with their sums (payers without any selected
   * obligation have obligations = 0).
   */
  private balances(admin: AdminPrincipal, f: PayerFilters, now: Date): Prisma.Sql {
    return Prisma.sql`WITH ob AS (
        SELECT o.id, o."payerId", o."feeId",
               COALESCE(SUM(e.amount) FILTER (WHERE e.type IN ('CHARGE', 'ADJUSTMENT')), 0)::bigint AS billed,
               (-COALESCE(SUM(e.amount) FILTER (WHERE e.type IN ('PAYMENT', 'REFUND')), 0))::bigint AS collected,
               COALESCE(SUM(e.amount), 0)::bigint AS balance,
               (f."dueDate" IS NOT NULL AND f."dueDate" < ${now}) AS due
        FROM "Obligation" o
        JOIN "Fee" f ON f.id = o."feeId"
        JOIN "FeeType" ft ON ft.id = f."feeTypeId"
        LEFT JOIN "LedgerEntry" e ON e."obligationId" = o.id
        WHERE ${this.feeWhere(f)}
        GROUP BY o.id, f."dueDate"
      ), pp AS (
        SELECT py.id, py.kind::text AS kind, py.ref, py."fullName", py.phone, py."programCode", py.department, py.level,
               py."enrolmentStatus"::text AS "enrolmentStatus", py."applicantStatus",
               COUNT(ob.id)::int AS obligations,
               COALESCE(SUM(ob.billed), 0)::bigint AS billed,
               COALESCE(SUM(ob.collected), 0)::bigint AS collected,
               COALESCE(SUM(GREATEST(ob.balance, 0)), 0)::bigint AS outstanding,
               COALESCE(SUM(GREATEST(ob.balance, 0)) FILTER (WHERE ob.due), 0)::bigint AS "overdueAmount"
        FROM "Payer" py
        LEFT JOIN ob ON ob."payerId" = py.id
        WHERE ${this.payerWhere(admin, f)}
        GROUP BY py.id
      )`;
  }

  private static feeFiltered(f: FeeFilters): boolean {
    return !!(f.feeId || f.feeType || f.period);
  }

  // ── Outstanding report ─────────────────────────────────────────────────────

  async outstanding(admin: AdminPrincipal, f: Omit<PayerFilters, 'kind' | 'q' | 'enrolmentStatus'>, now = new Date()) {
    const students = this.balances(admin, { ...f, kind: 'STUDENT' }, now);
    // applicants have no level or enrolment status
    const applicants = this.balances(admin, { ...f, kind: 'APPLICANT', level: undefined }, now);

    const [grid, byFee, byStatus, roster, last] = await Promise.all([
      this.prisma.$queryRaw<CellRow[]>`${students}
        SELECT pp.department, d.name AS "departmentName", fa.code AS "facultyCode", fa.name AS "facultyName", pp.level,
               COUNT(*)::int AS students, SUM(pp.billed)::bigint AS billed, SUM(pp.collected)::bigint AS collected,
               SUM(pp.outstanding)::bigint AS outstanding,
               COUNT(*) FILTER (WHERE pp.outstanding <= 0)::int AS paid,
               COUNT(*) FILTER (WHERE pp.outstanding > 0 AND pp.collected > 0)::int AS "partPaid",
               COUNT(*) FILTER (WHERE pp.outstanding > 0 AND pp.collected <= 0)::int AS unpaid,
               COUNT(*) FILTER (WHERE pp."overdueAmount" > 0)::int AS overdue,
               SUM(pp."overdueAmount")::bigint AS "overdueAmount"
        FROM pp
        LEFT JOIN "Department" d ON d.code = pp.department
        LEFT JOIN "Faculty" fa ON fa.id = d."facultyId"
        WHERE pp.obligations > 0
        GROUP BY pp.department, d.name, fa.code, fa.name, pp.level
        ORDER BY fa.code NULLS LAST, pp.department NULLS LAST, pp.level NULLS LAST`,
      this.prisma.$queryRaw<{ feeId: string; feeName: string; period: string; feeTypeCode: string; dueDate: Date | null; obligations: number; billed: bigint; collected: bigint; outstanding: bigint }[]>`${students}
        SELECT f.id AS "feeId", f.name AS "feeName", f.period, ft.code AS "feeTypeCode", f."dueDate",
               COUNT(*)::int AS obligations, SUM(ob.billed)::bigint AS billed, SUM(ob.collected)::bigint AS collected,
               SUM(GREATEST(ob.balance, 0))::bigint AS outstanding
        FROM ob
        JOIN pp ON pp.id = ob."payerId"
        JOIN "Fee" f ON f.id = ob."feeId"
        JOIN "FeeType" ft ON ft.id = f."feeTypeId"
        GROUP BY f.id, f.name, f.period, ft.code, f."dueDate"
        ORDER BY 4 DESC, f.period DESC, f.name`,
      this.prisma.$queryRaw<{ status: string | null; applicants: number; billed: bigint; collected: bigint; outstanding: bigint; paid: number }[]>`${applicants}
        SELECT pp."applicantStatus" AS status, COUNT(*)::int AS applicants, SUM(pp.billed)::bigint AS billed,
               SUM(pp.collected)::bigint AS collected, SUM(pp.outstanding)::bigint AS outstanding,
               COUNT(*) FILTER (WHERE pp.outstanding <= 0)::int AS paid
        FROM pp WHERE pp.obligations > 0
        GROUP BY 1 ORDER BY 1 NULLS LAST`,
      // every active student, whatever the fee filter: those without any obligation usually mean a missing rate rule
      this.prisma.$queryRaw<{ students: number; withoutObligations: number }[]>`
        SELECT COUNT(*)::int AS students,
               COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "Obligation" o WHERE o."payerId" = py.id))::int AS "withoutObligations"
        FROM "Payer" py
        WHERE ${this.payerWhere(admin, { ...f, kind: 'STUDENT', includeInactive: false })}`,
      this.prisma.portalEvent.findFirst({ where: { result: 'APPLIED' }, orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } }),
    ]);

    return {
      asOf: now,
      filters: {
        feeId: f.feeId ?? null, feeType: f.feeType ?? null, period: f.period ?? null, faculty: f.faculty ?? null,
        department: f.department ?? null, level: f.level ?? null, includeInactive: !!f.includeInactive,
        departments: admin.departmentScoped ? [...admin.departments] : null,
      },
      totals: sumTotals(grid),
      grid: grid.map((c) => ({ ...c, collectionRate: collectionRate(c.billed, c.collected) })),
      byFee: byFee.map((r) => ({ ...r, collectionRate: collectionRate(r.billed, r.collected) })),
      applicants: { byStatus },
      roster: { activeStudents: roster[0]!.students, withoutObligations: roster[0]!.withoutObligations, lastPortalEventAt: last?.receivedAt ?? null },
    };
  }

  // ── Payer list ─────────────────────────────────────────────────────────────

  private listSql(admin: AdminPrincipal, q: Omit<PayerListQuery, 'limit'>, now: Date): { cte: Prisma.Sql; where: Prisma.Sql; order: Prisma.Sql; keyset: (c: Cursor) => Prisma.Sql } {
    const sort = q.sort ?? '-balance';
    const col = { '-balance': Prisma.sql`pp.outstanding`, balance: Prisma.sql`pp.outstanding`, name: Prisma.sql`pp."fullName"`, ref: Prisma.sql`pp.ref` }[sort];
    const desc = sort === '-balance';
    return {
      cte: this.balances(admin, q, now),
      where: and([
        AdminAnalyticsService.feeFiltered(q) ? Prisma.sql`pp.obligations > 0` : null,
        q.standing === 'OVERDUE' ? Prisma.sql`pp."overdueAmount" > 0` : q.standing ? Prisma.sql`${STANDING_SQL} = ${q.standing}` : null,
      ]),
      order: desc ? Prisma.sql`${col} DESC, pp.id ASC` : Prisma.sql`${col} ASC, pp.id ASC`,
      keyset: (c) => {
        const v = sort === 'balance' || sort === '-balance' ? Prisma.sql`${BigInt(c.v)}::bigint` : Prisma.sql`${c.v}`;
        return desc
          ? Prisma.sql`(${col} < ${v} OR (${col} = ${v} AND pp.id > ${c.id}::uuid))`
          : Prisma.sql`(${col} > ${v} OR (${col} = ${v} AND pp.id > ${c.id}::uuid))`;
      },
    };
  }

  private async page(admin: AdminPrincipal, q: Omit<PayerListQuery, 'limit'>, take: number, cursor: Cursor | null, now: Date): Promise<PayerRow[]> {
    const s = this.listSql(admin, q, now);
    return this.prisma.$queryRaw<PayerRow[]>`${s.cte}
      SELECT pp.*, d.name AS "departmentName", fa.code AS "facultyCode",
             (SELECT MAX(p."completedAt") FROM "Payment" p JOIN "Obligation" o2 ON o2.id = p."obligationId"
               WHERE o2."payerId" = pp.id AND p.status = 'COMPLETED') AS "lastPaymentAt"
      FROM pp
      LEFT JOIN "Department" d ON d.code = pp.department
      LEFT JOIN "Faculty" fa ON fa.id = d."facultyId"
      WHERE ${s.where} AND ${cursor ? s.keyset(cursor) : Prisma.sql`TRUE`}
      ORDER BY ${s.order}
      LIMIT ${take}`;
  }

  async listPayers(admin: AdminPrincipal, q: PayerListQuery, now = new Date()) {
    const rows = await this.page(admin, q, q.limit + 1, q.cursor ? decodeCursor(q.cursor) : null, now);
    const items = rows.slice(0, q.limit);
    const last = items[items.length - 1];
    return { items: items.map(presentRow), nextCursor: rows.length > q.limit && last ? encodeCursor(q.sort ?? '-balance', last) : null };
  }

  /** CSV of the list (masked phones), in list order, at most EXPORT_MAX_ROWS. Audited. */
  async *exportPayers(admin: AdminPrincipal, q: Omit<PayerListQuery, 'limit' | 'cursor'>, now = new Date()): AsyncGenerator<string> {
    const s = this.listSql(admin, q, now);
    const total = (await this.prisma.$queryRaw<{ total: number }[]>`${s.cte} SELECT COUNT(*)::int AS total FROM pp WHERE ${s.where}`)[0]!.total;
    if (total > EXPORT_MAX_ROWS) throw new DomainError('VALIDATION', `${total} payers match; exports are limited to ${EXPORT_MAX_ROWS}. Narrow the filters.`);
    await this.audit.record({ actorId: admin.id, action: 'payers.export', entity: 'Payer', entityId: 'export', after: { filters: q, rows: total } });
    yield `${PAYER_CSV_COLUMNS.join(',')}\r\n`;
    let cursor: Cursor | null = null;
    for (;;) {
      const rows = await this.page(admin, q, EXPORT_BATCH, cursor, now);
      if (rows.length) yield rows.map((r) => `${payerCsvRow(r)}\r\n`).join('');
      if (rows.length < EXPORT_BATCH) return;
      cursor = cursorOf(q.sort ?? '-balance', rows[rows.length - 1]!);
    }
  }

  // ── One payer ──────────────────────────────────────────────────────────────

  async getPayer(admin: AdminPrincipal, id: string, now = new Date()) {
    const p = await this.prisma.payer.findUnique({
      where: { id },
      include: {
        obligations: {
          orderBy: { createdAt: 'asc' },
          include: {
            fee: { include: { feeType: true, instalmentRules: true } },
            entries: { orderBy: { createdAt: 'asc' } },
            payments: { orderBy: { createdAt: 'desc' }, include: { receipt: true } },
          },
        },
        receipts: { orderBy: { issuedAt: 'desc' } },
      },
    });
    if (!p || (admin.departmentScoped && !admin.departments.includes(p.department ?? ''))) throw new DomainError('NOT_FOUND', 'Payer not found');

    const [dept, linked, events] = await Promise.all([
      p.department ? this.prisma.department.findUnique({ where: { code: p.department }, include: { faculty: true } }) : null,
      p.kind === 'STUDENT'
        ? p.applicationRef ? this.prisma.payer.findUnique({ where: { kind_ref: { kind: 'APPLICANT', ref: p.applicationRef } }, select: { id: true, ref: true } }) : null
        : this.prisma.payer.findFirst({ where: { kind: 'STUDENT', applicationRef: p.ref }, select: { id: true, ref: true } }),
      this.prisma.portalEvent.findMany({
        where: { ref: p.ref, type: p.kind === 'STUDENT' ? 'student.upserted' : 'applicant.upserted' },
        orderBy: { receivedAt: 'desc' }, take: 20,
        select: { id: true, type: true, result: true, error: true, occurredAt: true, receivedAt: true },
      }),
    ]);

    const obligations = p.obligations.map((o) => {
      const sum = (types: string[]) => o.entries.filter((e) => types.includes(e.type)).reduce((s, e) => s + e.amount, 0n);
      const balance = o.entries.reduce((s, e) => s + e.amount, 0n);
      const outstanding = balance > 0n ? balance : 0n;
      const rule = pickInstalmentRule(o.fee.instalmentRules, p.department, p.level);
      return {
        id: o.id, status: o.status, amount: o.amount, rateRuleId: o.rateRuleId, createdAt: o.createdAt,
        fee: { id: o.fee.id, name: o.fee.name, period: o.fee.period, feeTypeCode: o.fee.feeType.code, status: o.fee.status, dueDate: o.fee.dueDate },
        billed: sum(['CHARGE', 'ADJUSTMENT']),
        collected: -sum(['PAYMENT', 'REFUND']),
        balance,
        overdue: outstanding > 0n && !!o.fee.dueDate && o.fee.dueDate < now,
        /** smallest next payment the channels accept against the balance */
        minInstalment: minInstalment({ allowInstalments: o.fee.allowInstalments, defaultMinInstalment: o.fee.defaultMinInstalment, ruleMinInstalment: rule?.minInstalment ?? null }, outstanding),
        entries: o.entries.map((e) => ({ id: e.id, type: e.type, amount: e.amount, memo: e.memo, paymentId: e.paymentId, createdBy: e.createdBy, createdAt: e.createdAt })),
        payments: o.payments.map((x) => ({
          id: x.id, paymentRef: x.paymentRef, amount: x.amount, status: x.status, channel: x.channel, collectionMethod: x.collectionMethod,
          payerPhone: x.payerPhone, createdAt: x.createdAt, completedAt: x.completedAt, failureReason: x.failureReason, receiptNumber: x.receipt?.number ?? null,
        })),
      };
    });
    const totals = {
      obligations: obligations.length,
      billed: obligations.reduce((s, o) => s + o.billed, 0n),
      collected: obligations.reduce((s, o) => s + o.collected, 0n),
      outstanding: obligations.reduce((s, o) => s + (o.balance > 0n ? o.balance : 0n), 0n),
    };

    return {
      payer: {
        id: p.id, kind: p.kind, ref: p.ref, fullName: p.fullName, phone: p.phone, programCode: p.programCode,
        department: p.department, departmentName: dept?.name ?? null, facultyCode: dept?.faculty?.code ?? null, facultyName: dept?.faculty?.name ?? null,
        level: p.level, finalYear: p.finalYear, residency: p.residency, intake: p.intake,
        applicantStatus: p.applicantStatus, enrolmentStatus: p.enrolmentStatus, applicationRef: p.applicationRef,
        portalUpdatedAt: p.portalUpdatedAt, snapshotAt: p.snapshotAt,
      },
      linked: { applicant: p.kind === 'STUDENT' ? linked : null, student: p.kind === 'APPLICANT' ? linked : null },
      totals: { ...totals, standing: standing(totals), overdue: obligations.some((o) => o.overdue), collectionRate: collectionRate(totals.billed, totals.collected) },
      obligations,
      receipts: p.receipts.map((r) => ({ id: r.id, number: r.number, amount: r.amount, issuedAt: r.issuedAt, obligationId: r.obligationId, paymentId: r.paymentId })),
      portalEvents: events,
    };
  }
}

// ── Rows, cursors, CSV ───────────────────────────────────────────────────────

function presentRow(r: PayerRow) {
  return {
    id: r.id, kind: r.kind, ref: r.ref, fullName: r.fullName, maskedPhone: maskPhone(r.phone), programCode: r.programCode,
    department: r.department, departmentName: r.departmentName, facultyCode: r.facultyCode, level: r.level,
    enrolmentStatus: r.enrolmentStatus, applicantStatus: r.applicantStatus,
    obligations: r.obligations, billed: r.billed, collected: r.collected, balance: r.outstanding,
    standing: standing({ obligations: r.obligations, billed: r.billed, collected: r.collected, outstanding: r.outstanding }),
    overdue: r.overdueAmount > 0n, overdueAmount: r.overdueAmount, lastPaymentAt: r.lastPaymentAt,
  };
}

interface Cursor { v: string; id: string }

function cursorOf(sort: PayerSort, r: PayerRow): Cursor {
  return { v: sort === 'name' ? r.fullName : sort === 'ref' ? r.ref : r.outstanding.toString(), id: r.id };
}

function encodeCursor(sort: PayerSort, r: PayerRow): string {
  return Buffer.from(JSON.stringify(cursorOf(sort, r))).toString('base64url');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeCursor(s: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof c.v === 'string' && typeof c.id === 'string' && UUID.test(c.id)) return { v: c.v, id: c.id };
  } catch { /* fall through */ }
  throw new DomainError('VALIDATION', 'cursor is not valid; use nextCursor from the previous page with the same sort');
}

export const PAYER_CSV_COLUMNS = [
  'kind', 'ref', 'full_name', 'phone_masked', 'program', 'department', 'department_name', 'faculty', 'level',
  'enrolment_status', 'applicant_status', 'obligations', 'billed_sle', 'collected_sle', 'balance_sle', 'standing',
  'overdue', 'overdue_sle', 'last_payment_at', 'payer_id',
] as const;

function payerCsvRow(r: PayerRow): string {
  const p = presentRow(r);
  return [
    p.kind, p.ref, p.fullName, p.maskedPhone, p.programCode, p.department, p.departmentName, p.facultyCode, p.level,
    p.enrolmentStatus, p.applicantStatus, p.obligations, sle(p.billed), sle(p.collected), sle(p.balance), p.standing,
    p.overdue ? 'yes' : 'no', sle(p.overdueAmount), p.lastPaymentAt?.toISOString() ?? null, p.id,
  ].map(cell).join(',');
}
