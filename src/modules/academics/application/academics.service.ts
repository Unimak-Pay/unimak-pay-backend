import { Injectable, Logger } from '@nestjs/common';
import type { Department, Faculty } from '@prisma/client';
import { DomainError } from '../../../shared/domain/errors';
import { type Db, PrismaService } from '../../../shared/infrastructure/prisma.service';
import { AuditService } from '../../audit/audit.service';

/** What the portal sends and what rules store, so it must match exactly (case included). */
export const ACADEMIC_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

const OPEN_FEES = { fee: { status: { not: 'CLOSED' as const } } };

export type DepartmentView = Department & { facultyCode: string | null; facultyName: string | null };

export interface DepartmentNames { departmentName: string; facultyCode: string | null; facultyName: string | null }

export const NO_NAMES: DepartmentNames = { departmentName: '', facultyCode: null, facultyName: null };

const view = (d: Department & { faculty: Faculty | null }): DepartmentView => {
  const { faculty, ...rest } = d;
  return { ...rest, facultyCode: faculty?.code ?? null, facultyName: faculty?.name ?? null };
};

/**
 * Faculties → departments. Department codes are what the portal sends for a
 * payer and what fee rules, minimum instalments and heads of department store
 * (as text), so codes never change; names do, and nothing is ever deleted.
 */
@Injectable()
export class AcademicsService {
  private readonly logger = new Logger(AcademicsService.name);
  /** Department codes known to exist (saves a write per payer lookup). */
  private readonly seen = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  async listFaculties() {
    return this.prisma.faculty.findMany({
      orderBy: { name: 'asc' },
      include: { departments: { orderBy: { name: 'asc' } } },
    });
  }

  async listDepartments(q: { faculty?: string; needsReview?: boolean; active?: boolean } = {}): Promise<DepartmentView[]> {
    const rows = await this.prisma.department.findMany({
      where: {
        ...(q.faculty ? { faculty: { code: q.faculty } } : {}),
        ...(q.needsReview !== undefined ? { needsReview: q.needsReview } : {}),
        ...(q.active !== undefined ? { active: q.active } : {}),
      },
      include: { faculty: true },
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
    });
    return rows.map(view);
  }

  async getDepartment(code: string): Promise<DepartmentView> {
    const d = await this.prisma.department.findUnique({ where: { code }, include: { faculty: true } });
    if (!d) throw new DomainError('NOT_FOUND', `Department ${code} not found`);
    return view(d);
  }

  /** Names for department codes (for lists and exports). Unknown codes are absent. */
  async names(codes: Iterable<string | null>): Promise<Map<string, DepartmentNames>> {
    const wanted = [...new Set([...codes].filter((c): c is string => !!c))];
    if (!wanted.length) return new Map();
    const rows = await this.prisma.department.findMany({ where: { code: { in: wanted } }, include: { faculty: true } });
    return new Map(rows.map((d) => [d.code, { departmentName: d.name, facultyCode: d.faculty?.code ?? null, facultyName: d.faculty?.name ?? null }]));
  }

  // ── Faculties (academics.manage) ───────────────────────────────────────────

  async createFaculty(actorId: string, input: { code: string; name: string }) {
    assertCode(input.code);
    if (await this.prisma.faculty.findUnique({ where: { code: input.code } })) {
      throw new DomainError('INVALID_STATE', `Faculty ${input.code} already exists`);
    }
    return this.prisma.$transaction(async (tx) => {
      const f = await tx.faculty.create({ data: { code: input.code, name: input.name.trim() } });
      await this.audit.record({ actorId, action: 'faculty.create', entity: 'Faculty', entityId: f.id, after: f }, tx);
      return f;
    });
  }

  /** Deactivating needs every department in it deactivated or moved first. */
  async updateFaculty(actorId: string, code: string, patch: { name?: string; active?: boolean }) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.faculty.findUnique({ where: { code } });
      if (!before) throw new DomainError('NOT_FOUND', `Faculty ${code} not found`);
      if (patch.active === false && before.active) {
        const active = await tx.department.findMany({ where: { facultyId: before.id, active: true }, select: { code: true } });
        if (active.length) {
          throw new DomainError('INVALID_STATE', `Faculty ${code} still has active departments: ${active.map((d) => d.code).join(', ')}`, { departments: active.map((d) => d.code) });
        }
        const deans = await tx.adminUser.findMany({ where: { active: true, role: 'DEAN', faculties: { has: code } }, select: { email: true } });
        if (deans.length) throw new DomainError('INVALID_STATE', `Faculty ${code} is still assigned to deans: ${deans.map((d) => d.email).join(', ')}`);
      }
      const after = await tx.faculty.update({ where: { code }, data: { ...(patch.name ? { name: patch.name.trim() } : {}), ...(patch.active !== undefined ? { active: patch.active } : {}) } });
      await this.audit.record({ actorId, action: 'faculty.update', entity: 'Faculty', entityId: after.id, before, after }, tx);
      return after;
    });
  }

  // ── Departments (academics.manage) ─────────────────────────────────────────

  async createDepartment(actorId: string, input: { code: string; name: string; facultyCode: string }): Promise<DepartmentView> {
    assertCode(input.code);
    if (await this.prisma.department.findUnique({ where: { code: input.code } })) {
      throw new DomainError('INVALID_STATE', `Department ${input.code} already exists`);
    }
    return this.prisma.$transaction(async (tx) => {
      const faculty = await activeFaculty(tx, input.facultyCode);
      const d = await tx.department.create({ data: { code: input.code, name: input.name.trim(), facultyId: faculty.id }, include: { faculty: true } });
      await this.audit.record({ actorId, action: 'department.create', entity: 'Department', entityId: d.id, after: d }, tx);
      this.seen.add(d.code);
      return view(d);
    });
  }

  /**
   * Rename, move to another faculty, (de)activate. Giving a department that
   * needs review a faculty marks it reviewed. Deactivating is refused while a
   * head of department or a rule on an open fee uses it.
   */
  async updateDepartment(actorId: string, code: string, patch: { name?: string; facultyCode?: string; active?: boolean }): Promise<DepartmentView> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.department.findUnique({ where: { code } });
      if (!before) throw new DomainError('NOT_FOUND', `Department ${code} not found`);
      const facultyId = patch.facultyCode ? (await activeFaculty(tx, patch.facultyCode)).id : before.facultyId;
      if (before.needsReview && !facultyId && patch.active !== false) {
        throw new DomainError('VALIDATION', `Department ${code} needs a faculty (facultyCode)`);
      }
      if (patch.active === false && before.active) await assertUnused(tx, code);
      const after = await tx.department.update({
        where: { code },
        data: {
          ...(patch.name ? { name: patch.name.trim() } : {}),
          facultyId,
          ...(patch.active !== undefined ? { active: patch.active } : {}),
          needsReview: before.needsReview && !facultyId,
        },
        include: { faculty: true },
      });
      await this.audit.record({ actorId, action: 'department.update', entity: 'Department', entityId: after.id, before, after: { ...after, faculty: undefined } }, tx);
      return view(after);
    });
  }

  // ── Checks used by fee rules and admin users ───────────────────────────────

  /** Every code must be an existing, active, reviewed department. */
  async assertUsableDepartments(codes: readonly (string | null | undefined)[], db: Db = this.prisma): Promise<void> {
    const wanted = [...new Set(codes.filter((c): c is string => !!c))];
    if (!wanted.length) return;
    const rows = await db.department.findMany({ where: { code: { in: wanted } } });
    const byCode = new Map(rows.map((r) => [r.code, r]));
    for (const c of wanted) {
      const d = byCode.get(c);
      if (!d) throw new DomainError('VALIDATION', `Unknown department ${c}`, { department: c });
      if (!d.active) throw new DomainError('VALIDATION', `Department ${c} is inactive`, { department: c });
      if (d.needsReview) throw new DomainError('VALIDATION', `Department ${c} needs review (give it a name and faculty first)`, { department: c });
    }
  }

  /** Every code must be an existing, active faculty. */
  async assertUsableFaculties(codes: readonly string[], db: Db = this.prisma): Promise<void> {
    const wanted = [...new Set(codes)];
    if (!wanted.length) return;
    const rows = await db.faculty.findMany({ where: { code: { in: wanted } } });
    const byCode = new Map(rows.map((r) => [r.code, r]));
    for (const c of wanted) {
      const f = byCode.get(c);
      if (!f) throw new DomainError('VALIDATION', `Unknown faculty ${c}`, { faculty: c });
      if (!f.active) throw new DomainError('VALIDATION', `Faculty ${c} is inactive`, { faculty: c });
    }
  }

  // ── Departments seen from the portal ───────────────────────────────────────

  /**
   * A department code the portal sent that we don't have is added as "needs
   * review" (name = code, no faculty). Never throws: payments don't depend on it.
   */
  async registerSeen(code: string | null | undefined): Promise<void> {
    const c = code?.trim();
    if (!c || this.seen.has(c)) return;
    try {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO "Department" (id, code, name, "needsReview", "updatedAt")
        VALUES (gen_random_uuid(), ${c}, ${c}, true, now())
        ON CONFLICT (code) DO NOTHING
        RETURNING id`;
      if (rows[0]) {
        this.logger.warn(`Portal sent unknown department ${c}; added it for review`);
        await this.audit.record({ actorId: 'system', action: 'department.auto_register', entity: 'Department', entityId: rows[0].id, after: { code: c } });
      }
      this.seen.add(c);
    } catch (err) {
      this.logger.error(`Could not register department ${c}: ${(err as Error).message}`);
    }
  }
}

function assertCode(code: string): void {
  if (!ACADEMIC_CODE.test(code)) throw new DomainError('VALIDATION', 'Code: 1–40 letters, digits, "-", "_" or ".", starting with a letter or digit');
}

async function activeFaculty(db: Db, code: string): Promise<Faculty> {
  const f = await db.faculty.findUnique({ where: { code } });
  if (!f) throw new DomainError('VALIDATION', `Unknown faculty ${code}`, { faculty: code });
  if (!f.active) throw new DomainError('INVALID_STATE', `Faculty ${code} is inactive`, { faculty: code });
  return f;
}

async function assertUnused(db: Db, code: string): Promise<void> {
  const [heads, rate, eligibility, instalment] = await Promise.all([
    db.adminUser.findMany({ where: { active: true, role: 'HEAD_OF_DEPARTMENT', departments: { has: code } }, select: { email: true } }),
    db.rateRule.count({ where: { department: code, ...OPEN_FEES } }),
    db.eligibilityRule.count({ where: { department: code, ...OPEN_FEES } }),
    db.instalmentRule.count({ where: { department: code, ...OPEN_FEES } }),
  ]);
  const uses = [
    ...(heads.length ? [`heads of department: ${heads.map((h) => h.email).join(', ')}`] : []),
    ...(rate ? [`${rate} rate rule(s)`] : []),
    ...(eligibility ? [`${eligibility} eligibility rule(s)`] : []),
    ...(instalment ? [`${instalment} minimum-instalment rule(s)`] : []),
  ];
  if (uses.length) {
    throw new DomainError('INVALID_STATE', `Department ${code} is still used by ${uses.join('; ')} (on fees that aren't closed)`, { uses });
  }
}
