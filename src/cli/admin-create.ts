/**
 * pnpm admin:create --email bursar@unimak.edu.sl --role SUPER_ADMIN [--name "…"] [--departments COMPUTER-SCI,NURSING] [--faculties FAC-NURSING-AHS]
 * Bootstraps admins (e.g. the first super admin). The person then signs in to
 * the admin portal with Supabase Auth using this email.
 */
import os from 'node:os';
import { parseArgs } from 'node:util';
import type { AdminRole } from '@prisma/client';
import { AuditService } from '../modules/audit/audit.service';
import { PrismaService } from '../shared/infrastructure/prisma.service';
import { withApp } from './context';

const ROLES: AdminRole[] = ['SUPER_ADMIN', 'BURSAR', 'FINANCE_OFFICER', 'HEAD_OF_DEPARTMENT', 'DEAN', 'AUDITOR'];
const { values: a } = parseArgs({ options: { email: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' }, departments: { type: 'string' }, faculties: { type: 'string' } } });

void withApp(async (app) => {
  const email = a.email?.trim().toLowerCase();
  const role = a.role?.toUpperCase() as AdminRole | undefined;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !role || !ROLES.includes(role)) {
    throw new Error(`Usage: --email <email> --role ${ROLES.join('|')} [--name] [--departments A,B] [--faculties A,B]`);
  }
  const departments = a.departments?.split(',').map((d) => d.trim()).filter(Boolean) ?? [];
  if (role === 'HEAD_OF_DEPARTMENT' && !departments.length) throw new Error('HEAD_OF_DEPARTMENT needs --departments');
  const faculties = a.faculties?.split(',').map((f) => f.trim()).filter(Boolean) ?? [];
  if (role === 'DEAN' && !faculties.length) throw new Error('DEAN needs --faculties');
  const prisma = app.get(PrismaService);
  if (await prisma.adminUser.findUnique({ where: { email } })) throw new Error(`${email} already exists`);
  const actorId = `cli:${os.userInfo().username}`;
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.adminUser.create({ data: { email, role, name: a.name ?? null, departments: role === 'HEAD_OF_DEPARTMENT' ? departments : [], faculties: role === 'DEAN' ? faculties : [], createdBy: actorId } });
    await app.get(AuditService).record({ actorId, action: 'admin_user.create', entity: 'AdminUser', entityId: u.id, after: u }, tx);
    return u;
  });
  console.log(`✓ Admin ${user.email} (${user.role}) created. They can now sign in with Supabase Auth.`);
});
