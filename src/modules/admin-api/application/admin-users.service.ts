import { Inject, Injectable } from '@nestjs/common';
import type { AdminRole } from '@prisma/client';
import { DomainError } from '../../../shared/domain/errors';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { AcademicsService } from '../../academics/application/academics.service';
import { AuditService } from '../../audit/audit.service';
import type { AdminPrincipal } from '../../auth/application/admin-principal';
import { AUTH_INVITER, type AuthInviter, type InviteOutcome } from '../../auth/application/auth-inviter.port';
import { effectivePermissions } from '../../auth/domain/permissions';

/** No privilege escalation: only super admins touch super admins, others grant only what they hold. */
function assertCanGrant(actor: AdminPrincipal, role: AdminRole, extra: readonly string[], targetRole?: AdminRole): void {
  if (actor.role === 'SUPER_ADMIN') return;
  if (role === 'SUPER_ADMIN' || targetRole === 'SUPER_ADMIN') throw new DomainError('FORBIDDEN', 'Only a super admin can create or change super admins');
  const beyond = [...effectivePermissions(role, extra)].filter((p) => !actor.permissions.has(p));
  if (beyond.length) throw new DomainError('FORBIDDEN', `You cannot grant permissions you don't have: ${beyond.join(', ')}`);
}

/**
 * Invitations: create the AdminUser here and ask Supabase Auth to email the
 * person an invite link (they set a password, or sign in with OAuth using that
 * email). The first sign-in binds the AdminUser to their Supabase user.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(AUTH_INVITER) private readonly inviter: AuthInviter,
    private readonly academics: AcademicsService,
  ) {}

  list() {
    return this.prisma.adminUser.findMany({ orderBy: { email: 'asc' } });
  }

  async get(id: string) {
    const u = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!u) throw new DomainError('NOT_FOUND', 'Admin user not found');
    return u;
  }

  async create(actor: AdminPrincipal, input: { email: string; name?: string; role: AdminRole; extraPermissions?: string[]; departments?: string[]; faculties?: string[] }) {
    const email = input.email.trim().toLowerCase();
    assertCanGrant(actor, input.role, input.extraPermissions ?? []);
    const scope = await this.scopeFor(input.role, input.departments ?? [], input.faculties ?? []);
    if (await this.prisma.adminUser.findUnique({ where: { email } })) throw new DomainError('INVALID_STATE', `${email} is already an admin`);
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.adminUser.create({
        data: { email, name: input.name ?? null, role: input.role, extraPermissions: input.extraPermissions ?? [], ...scope, createdBy: actor.id },
      });
      await this.audit.record({ actorId: actor.id, action: 'admin_user.create', entity: 'AdminUser', entityId: created.id, after: created }, tx);
      return created;
    });
    // After the commit: a failed email never loses the invitation (re-send with POST users/:id/invite).
    return { ...user, invitation: await this.sendInvite(actor, user.id, email) };
  }

  /** Re-sends the Supabase invite email to someone who hasn't signed in yet. */
  async resendInvite(actor: AdminPrincipal, id: string) {
    const user = await this.get(id);
    if (user.authUserId) throw new DomainError('INVALID_STATE', 'This admin has already signed in; they can use "Forgot password"');
    if (!user.active) throw new DomainError('INVALID_STATE', 'This admin is deactivated');
    assertCanGrant(actor, user.role, user.extraPermissions, user.role);
    return { ...user, invitation: await this.sendInvite(actor, user.id, user.email) };
  }

  private async sendInvite(actor: AdminPrincipal, id: string, email: string): Promise<InviteOutcome> {
    const outcome = await this.inviter.invite(email);
    await this.audit.record({ actorId: actor.id, action: 'admin_user.invite', entity: 'AdminUser', entityId: id, after: outcome });
    return outcome;
  }

  /** Heads of department need departments, deans faculties; other roles keep neither. */
  private async scopeFor(role: AdminRole, departments: string[], faculties: string[]) {
    if (role === 'HEAD_OF_DEPARTMENT') {
      if (!departments.length) throw new DomainError('VALIDATION', 'A head of department needs at least one department');
      await this.academics.assertUsableDepartments(departments);
      return { departments: [...new Set(departments)], faculties: [] };
    }
    if (role === 'DEAN') {
      if (!faculties.length) throw new DomainError('VALIDATION', 'A dean needs at least one faculty');
      await this.academics.assertUsableFaculties(faculties);
      return { departments: [], faculties: [...new Set(faculties)] };
    }
    return { departments: [], faculties: [] };
  }

  async update(actor: AdminPrincipal, id: string, patch: { name?: string; role?: AdminRole; extraPermissions?: string[]; departments?: string[]; faculties?: string[]; active?: boolean }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "AdminUser" WHERE role = 'SUPER_ADMIN' FOR UPDATE`;
      const before = await tx.adminUser.findUnique({ where: { id } });
      if (!before) throw new DomainError('NOT_FOUND', 'Admin user not found');
      if (id === actor.id && (patch.active === false || (patch.role && patch.role !== before.role))) {
        throw new DomainError('FORBIDDEN', 'You cannot deactivate yourself or change your own role');
      }
      const losesSuper = before.role === 'SUPER_ADMIN' && before.active && (patch.active === false || (patch.role && patch.role !== 'SUPER_ADMIN'));
      if (losesSuper && (await tx.adminUser.count({ where: { role: 'SUPER_ADMIN', active: true } })) <= 1) {
        throw new DomainError('INVALID_STATE', 'At least one active super admin must remain');
      }
      const role = patch.role ?? before.role;
      assertCanGrant(actor, role, patch.extraPermissions ?? before.extraPermissions, before.role);
      // only newly given codes are checked (a department deactivated since stays until changed)
      const departments = patch.departments ?? before.departments;
      const faculties = patch.faculties ?? before.faculties;
      if (role === 'HEAD_OF_DEPARTMENT' && departments.length === 0) throw new DomainError('VALIDATION', 'A head of department needs at least one department');
      if (role === 'DEAN' && faculties.length === 0) throw new DomainError('VALIDATION', 'A dean needs at least one faculty');
      if (patch.departments) await this.academics.assertUsableDepartments(patch.departments, tx);
      if (patch.faculties) await this.academics.assertUsableFaculties(patch.faculties, tx);
      const after = await tx.adminUser.update({ where: { id }, data: patch });
      await this.audit.record({ actorId: actor.id, action: 'admin_user.update', entity: 'AdminUser', entityId: id, before, after }, tx);
      return after;
    });
  }
}
