import { Injectable } from '@nestjs/common';
import type { AdminRole } from '@prisma/client';
import { DomainError } from '../../../shared/domain/errors';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { AuditService } from '../../audit/audit.service';
import type { AdminPrincipal } from '../../auth/application/admin-principal';
import { effectivePermissions } from '../../auth/domain/permissions';

/** No privilege escalation: only super admins touch super admins, others grant only what they hold. */
function assertCanGrant(actor: AdminPrincipal, role: AdminRole, extra: readonly string[], targetRole?: AdminRole): void {
  if (actor.role === 'SUPER_ADMIN') return;
  if (role === 'SUPER_ADMIN' || targetRole === 'SUPER_ADMIN') throw new DomainError('FORBIDDEN', 'Only a super admin can create or change super admins');
  const beyond = [...effectivePermissions(role, extra)].filter((p) => !actor.permissions.has(p));
  if (beyond.length) throw new DomainError('FORBIDDEN', `You cannot grant permissions you don't have: ${beyond.join(', ')}`);
}

/**
 * Invitations: create the AdminUser here, then the person signs in to the admin
 * portal with Supabase Auth (email + password or OAuth) using that email.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.adminUser.findMany({ orderBy: { email: 'asc' } });
  }

  async create(actor: AdminPrincipal, input: { email: string; name?: string; role: AdminRole; extraPermissions?: string[]; departments?: string[] }) {
    const email = input.email.trim().toLowerCase();
    assertCanGrant(actor, input.role, input.extraPermissions ?? []);
    if (input.role === 'HEAD_OF_DEPARTMENT' && !input.departments?.length) {
      throw new DomainError('VALIDATION', 'A head of department needs at least one department');
    }
    if (await this.prisma.adminUser.findUnique({ where: { email } })) throw new DomainError('INVALID_STATE', `${email} is already an admin`);
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.adminUser.create({
        data: { email, name: input.name ?? null, role: input.role, extraPermissions: input.extraPermissions ?? [], departments: input.departments ?? [], createdBy: actor.id },
      });
      await this.audit.record({ actorId: actor.id, action: 'admin_user.create', entity: 'AdminUser', entityId: user.id, after: user }, tx);
      return user;
    });
  }

  async update(actor: AdminPrincipal, id: string, patch: { name?: string; role?: AdminRole; extraPermissions?: string[]; departments?: string[]; active?: boolean }) {
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
      const departments = patch.departments ?? before.departments;
      if (role === 'HEAD_OF_DEPARTMENT' && departments.length === 0) throw new DomainError('VALIDATION', 'A head of department needs at least one department');
      const after = await tx.adminUser.update({ where: { id }, data: patch });
      await this.audit.record({ actorId: actor.id, action: 'admin_user.update', entity: 'AdminUser', entityId: id, before, after }, tx);
      return after;
    });
  }
}
