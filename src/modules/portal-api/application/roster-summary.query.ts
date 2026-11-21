import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';

/** docs/portal-events.md A8: our counts, for the portal to compare with its own. */
@Injectable()
export class RosterSummaryQuery {
  constructor(private readonly prisma: PrismaService) {}

  async execute(now = new Date()) {
    const [applicants, students, last] = await Promise.all([
      this.prisma.$queryRaw<{ department: string | null; status: string | null; count: number }[]>`
        SELECT department, "applicantStatus" AS status, count(*)::int AS count FROM "Payer"
        WHERE kind = 'APPLICANT' GROUP BY 1, 2 ORDER BY 1, 2`,
      this.prisma.$queryRaw<{ department: string | null; level: number | null; enrolmentStatus: string | null; count: number }[]>`
        SELECT department, level, "enrolmentStatus"::text AS "enrolmentStatus", count(*)::int AS count FROM "Payer"
        WHERE kind = 'STUDENT' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
      this.prisma.portalEvent.findFirst({ where: { result: 'APPLIED' }, orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } }),
    ]);
    return { asOf: now.toISOString(), applicants, students, lastEventAt: last?.receivedAt.toISOString() ?? null };
  }
}
