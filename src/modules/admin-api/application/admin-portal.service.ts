import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import type { AdminPrincipal } from '../../auth/application/admin-principal';

/** Statuses whose open balances need a person: no new charges, nothing written off automatically. */
const NOT_ACTIVE = ['SUSPENDED', 'WITHDRAWN', 'GRADUATED'] as const;

/** Admin views of the portal sync (docs/portal-events.md B3 step 5). */
@Injectable()
export class AdminPortalService {
  constructor(private readonly prisma: PrismaService) {}

  /** Newest first; `cursor` is the last event id of the previous page. */
  async events(q: { limit: number; cursor?: string; type?: string; result?: 'APPLIED' | 'STALE' | 'REJECTED'; ref?: string }) {
    const where: Prisma.PortalEventWhereInput = { ...(q.type ? { type: q.type } : {}), ...(q.result ? { result: q.result } : {}), ...(q.ref ? { ref: q.ref } : {}) };
    const [rows, last] = await Promise.all([
      this.prisma.portalEvent.findMany({
        where, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      }),
      this.prisma.portalEvent.findFirst({ where: { result: 'APPLIED' }, orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } }),
    ]);
    const items = rows.slice(0, q.limit);
    return { items, nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null, lastAppliedAt: last?.receivedAt ?? null };
  }

  /**
   * Students the portal says aren't active but who still owe something. Heads of
   * department and deans see their own departments only.
   */
  async needsReview(admin: AdminPrincipal, q: { limit: number; cursor?: string; department?: string; status?: (typeof NOT_ACTIVE)[number] }) {
    const where: Prisma.PayerWhereInput = {
      kind: 'STUDENT',
      enrolmentStatus: q.status ? q.status : { in: [...NOT_ACTIVE] },
      obligations: { some: { status: 'OPEN' } },
      ...(q.department ? { department: q.department } : {}),
      ...(admin.departmentScoped ? { AND: [{ department: { in: [...admin.departments] } }] } : {}),
    };
    const rows = await this.prisma.payer.findMany({
      where,
      orderBy: [{ portalUpdatedAt: 'desc' }, { id: 'asc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { obligations: { where: { status: 'OPEN' }, include: { fee: true, entries: { select: { amount: true } } }, orderBy: { createdAt: 'asc' } } },
    });
    const items = rows.slice(0, q.limit).map((p) => {
      const obligations = p.obligations.map((o) => ({
        id: o.id, feeName: o.fee.name, period: o.fee.period, amount: o.amount,
        balance: o.entries.reduce((sum, e) => sum + e.amount, 0n),
      }));
      return {
        id: p.id, ref: p.ref, fullName: p.fullName, department: p.department, level: p.level,
        enrolmentStatus: p.enrolmentStatus!, statusSince: p.portalUpdatedAt,
        obligations, totalBalance: obligations.reduce((sum, o) => sum + o.balance, 0n),
      };
    });
    return { items, nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null };
  }
}
