import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError } from '../../../shared/domain/errors';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import type { AdminPrincipal } from '../../auth/application/admin-principal';

const DAY = 24 * 60 * 60_000;
const MAX_DAYS = 366;
const DEFAULT_DAYS = 30;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ReportsSummaryQuery {
  /** YYYY-MM-DD, inclusive (Africa/Freetown = UTC). Default: 29 days before `to`. */
  from?: string;
  /** YYYY-MM-DD, inclusive. Default: today. */
  to?: string;
  feeType?: string;
  channel?: 'USSD' | 'DOTS';
  /** Department.code */
  department?: string;
  /** Faculty.code: its departments as they are now */
  faculty?: string;
}

interface Bucket { amount: bigint; count: number }

/**
 * Collection totals for the dashboard. Money collected = COMPLETED payments by
 * completedAt (a late settlement counts on the day Monime completed it).
 * Payment funnel = payments *created* in the range, by current status (open past
 * expiry counts as expired). Heads of department and deans only see their departments;
 * commission and payout sections need transfers.read / payouts.read and are
 * never department-scoped, so they're null otherwise.
 */
@Injectable()
export class AdminReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(admin: AdminPrincipal, q: ReportsSummaryQuery, now = new Date()) {
    const { from, to, start, end, days } = range(q, now);

    const where = Prisma.join(
      [
        Prisma.sql`TRUE`,
        q.feeType ? Prisma.sql`ft.code = ${q.feeType}` : null,
        q.channel ? Prisma.sql`p.channel = ${q.channel}::"Channel"` : null,
        q.department ? Prisma.sql`py.department = ${q.department}` : null,
        q.faculty ? Prisma.sql`py.department IN (SELECT d2.code FROM "Department" d2 JOIN "Faculty" f2 ON f2.id = d2."facultyId" WHERE f2.code = ${q.faculty})` : null,
        admin.departmentScoped ? Prisma.sql`py.department IN (${Prisma.join(admin.departments.length ? [...admin.departments] : [''])})` : null,
      ].filter((x): x is Prisma.Sql => x !== null),
      ' AND ',
    );
    const from_ = Prisma.sql`FROM "Payment" p
      JOIN "Obligation" o ON o.id = p."obligationId"
      JOIN "Fee" f ON f.id = o."feeId"
      JOIN "FeeType" ft ON ft.id = f."feeTypeId"
      JOIN "Payer" py ON py.id = o."payerId"
      LEFT JOIN "Department" d ON d.code = py.department
      LEFT JOIN "Faculty" fa ON fa.id = d."facultyId"`;
    const completed = Prisma.sql`p.status = 'COMPLETED' AND p."completedAt" >= ${start} AND p."completedAt" < ${end} AND ${where}`;

    const [totals, byDay, byFeeType, byChannel, funnel, byFaculty, byDepartment] = await Promise.all([
      this.prisma.$queryRaw<{ amount: bigint; count: number; monime: bigint; platform: bigint; net: bigint; late: number }[]>`
        SELECT COALESCE(SUM(p.amount), 0)::bigint AS amount, COUNT(*)::int AS count,
               COALESCE(SUM(p."monimeFee"), 0)::bigint AS monime, COALESCE(SUM(p."platformFee"), 0)::bigint AS platform,
               COALESCE(SUM(p."netAmount"), 0)::bigint AS net,
               COUNT(*) FILTER (WHERE p."completedAt" > p."expiresAt")::int AS late
        ${from_} WHERE ${completed}`,
      this.prisma.$queryRaw<{ day: string; amount: bigint; count: number }[]>`
        SELECT to_char(date_trunc('day', p."completedAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
               SUM(p.amount)::bigint AS amount, COUNT(*)::int AS count
        ${from_} WHERE ${completed} GROUP BY 1`,
      this.prisma.$queryRaw<{ code: string; name: string; amount: bigint; count: number; platform: bigint; net: bigint }[]>`
        SELECT ft.code, ft.name, SUM(p.amount)::bigint AS amount, COUNT(*)::int AS count,
               SUM(p."platformFee")::bigint AS platform, SUM(p."netAmount")::bigint AS net
        ${from_} WHERE ${completed} GROUP BY ft.code, ft.name ORDER BY 3 DESC, 1`,
      this.prisma.$queryRaw<{ channel: string; amount: bigint; count: number }[]>`
        SELECT p.channel::text AS channel, SUM(p.amount)::bigint AS amount, COUNT(*)::int AS count
        ${from_} WHERE ${completed} GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<{ status: string; count: number; amount: bigint }[]>`
        SELECT CASE WHEN p.status IN ('INITIATED', 'PENDING') AND p."expiresAt" <= ${now} THEN 'EXPIRED' ELSE p.status::text END AS status,
               COUNT(*)::int AS count, SUM(p.amount)::bigint AS amount
        ${from_} WHERE p."createdAt" >= ${start} AND p."createdAt" < ${end} AND ${where} GROUP BY 1`,
      // grouped by each department's current faculty
      this.prisma.$queryRaw<{ code: string | null; name: string | null; amount: bigint; count: number }[]>`
        SELECT fa.code, fa.name, SUM(p.amount)::bigint AS amount, COUNT(*)::int AS count
        ${from_} WHERE ${completed} GROUP BY fa.code, fa.name ORDER BY 3 DESC, 1 NULLS LAST`,
      this.prisma.$queryRaw<{ code: string | null; name: string | null; faculty: string | null; amount: bigint; count: number }[]>`
        SELECT py.department AS code, d.name, fa.code AS faculty, SUM(p.amount)::bigint AS amount, COUNT(*)::int AS count
        ${from_} WHERE ${completed} GROUP BY py.department, d.name, fa.code ORDER BY 4 DESC, 1 NULLS LAST`,
    ]);

    const t = totals[0]!;
    const dayMap = new Map(byDay.map((d) => [d.day, d]));
    const funnelBy = (s: string): Bucket => {
      const r = funnel.find((x) => x.status === s);
      return { count: r?.count ?? 0, amount: r?.amount ?? 0n };
    };
    const started = funnel.reduce((n, r) => n + r.count, 0);
    const completedStarted = funnelBy('COMPLETED').count;

    return {
      range: { from, to, days, timezone: 'Africa/Freetown (UTC)' },
      filters: { feeType: q.feeType ?? null, channel: q.channel ?? null, department: q.department ?? null, faculty: q.faculty ?? null, departments: admin.departmentScoped ? [...admin.departments] : null },
      collected: {
        amount: t.amount,
        count: t.count,
        average: t.count ? t.amount / BigInt(t.count) : 0n,
        monimeFees: t.monime,
        platformFees: t.platform,
        net: t.net,
        lateSettlements: t.late,
      },
      byDay: Array.from({ length: days }, (_, i) => {
        const day = new Date(start.getTime() + i * DAY).toISOString().slice(0, 10);
        const d = dayMap.get(day);
        return { date: day, amount: d?.amount ?? 0n, count: d?.count ?? 0 };
      }),
      byFeeType: byFeeType.map((r) => ({ feeTypeCode: r.code, feeTypeName: r.name, amount: r.amount, count: r.count, platformFees: r.platform, net: r.net })),
      /** facultyCode null: departments without a faculty (needing review) or payers without a department */
      byFaculty: byFaculty.map((r) => ({ facultyCode: r.code, facultyName: r.name, amount: r.amount, count: r.count })),
      byDepartment: byDepartment.map((r) => ({ department: r.code, departmentName: r.name, facultyCode: r.faculty, amount: r.amount, count: r.count })),
      byChannel: (['USSD', 'DOTS'] as const)
        .filter((c) => !q.channel || q.channel === c)
        .map((c) => {
          const r = byChannel.find((x) => x.channel === c);
          return { channel: c, amount: r?.amount ?? 0n, count: r?.count ?? 0 };
        }),
      payments: {
        started,
        completed: funnelBy('COMPLETED'),
        pending: { count: funnelBy('INITIATED').count + funnelBy('PENDING').count, amount: funnelBy('INITIATED').amount + funnelBy('PENDING').amount },
        failed: funnelBy('FAILED'),
        expired: funnelBy('EXPIRED'),
        /** completed ÷ started, 0–1 */
        completionRate: started ? Math.round((completedStarted / started) * 1000) / 1000 : null,
      },
      commission: admin.permissions.has('transfers.read') && !admin.departmentScoped ? await this.commission(start, end) : null,
      payouts: admin.permissions.has('payouts.read') && !admin.departmentScoped ? await this.payouts(start, end) : null,
    };
  }

  /** Commission transfers created in the range, by outcome. */
  private async commission(start: Date, end: Date) {
    const rows = await this.prisma.transfer.groupBy({
      by: ['status'],
      where: { kind: 'COMMISSION', createdAt: { gte: start, lt: end } },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const get = (...s: string[]): Bucket => rows.filter((r) => s.includes(r.status)).reduce<Bucket>((b, r) => ({ amount: b.amount + (r._sum.amount ?? 0n), count: b.count + r._count._all }), { amount: 0n, count: 0 });
    return { transferred: get('COMPLETED'), inFlight: get('PENDING', 'SUBMITTED'), failed: get('FAILED') };
  }

  /** Bank payouts requested in the range, by outcome. */
  private async payouts(start: Date, end: Date) {
    const rows = await this.prisma.payout.groupBy({
      by: ['status'],
      where: { createdAt: { gte: start, lt: end } },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const get = (...s: string[]): Bucket => rows.filter((r) => s.includes(r.status)).reduce<Bucket>((b, r) => ({ amount: b.amount + (r._sum.amount ?? 0n), count: b.count + r._count._all }), { amount: 0n, count: 0 });
    return { paidOut: get('COMPLETED'), inFlight: get('REQUESTED', 'SUBMITTED', 'PROCESSING'), failed: get('FAILED') };
  }
}

/** Inclusive YYYY-MM-DD days (UTC = Africa/Freetown) → [start, end) instants. */
export function range(q: { from?: string; to?: string }, now: Date) {
  for (const v of [q.from, q.to]) if (v !== undefined && (!DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) throw new DomainError('VALIDATION', 'from/to must be dates (YYYY-MM-DD)');
  const to = q.to ?? now.toISOString().slice(0, 10);
  const end = new Date(Date.parse(`${to}T00:00:00Z`) + DAY);
  const from = q.from ?? new Date(end.getTime() - DEFAULT_DAYS * DAY).toISOString().slice(0, 10);
  const start = new Date(`${from}T00:00:00Z`);
  const days = Math.round((end.getTime() - start.getTime()) / DAY);
  if (days < 1) throw new DomainError('VALIDATION', '`from` must be on or before `to`');
  if (days > MAX_DAYS) throw new DomainError('VALIDATION', `The range can be at most ${MAX_DAYS} days`);
  return { from, to, start, end, days };
}
