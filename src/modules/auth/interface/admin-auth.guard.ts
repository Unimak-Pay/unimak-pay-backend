import { type CanActivate, type ExecutionContext, Injectable, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DomainError } from '../../../shared/domain/errors';
import type { AdminPrincipal } from '../application/admin-principal';
import { AdminAuthenticator } from '../application/admin-authenticator';
import type { Permission } from '../domain/permissions';

const PERMISSIONS_KEY = 'admin:permissions';

/** All listed permissions are required. Routes without it only need a valid admin. */
export const RequirePermissions = (...permissions: Permission[]) => SetMetadata(PERMISSIONS_KEY, permissions);

type AdminRequest = Request & { admin?: AdminPrincipal };

export const CurrentAdmin = createParamDecorator((_: unknown, ctx: ExecutionContext): AdminPrincipal => {
  const admin = ctx.switchToHttp().getRequest<AdminRequest>().admin;
  if (!admin) throw new DomainError('UNAUTHENTICATED', 'Not authenticated');
  return admin;
});

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AdminAuthenticator,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    const admin = await this.auth.authenticate(req.header('authorization'));
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, [ctx.getHandler(), ctx.getClass()]) ?? [];
    const missing = required.filter((p) => !admin.permissions.has(p));
    if (missing.length) throw new DomainError('FORBIDDEN', `Missing permission ${missing.join(', ')}`);
    req.admin = admin;
    return true;
  }
}
