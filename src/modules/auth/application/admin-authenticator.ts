import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import { DomainError } from '../../../shared/domain/errors';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { JwtError, verifyJwt } from '../domain/jwt';
import { effectivePermissions, isDepartmentScoped, MFA_ROLES } from '../domain/permissions';
import { JwksKeyResolver } from '../infrastructure/jwks-key-resolver';
import type { AdminPrincipal } from './admin-principal';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LAST_LOGIN_THROTTLE_MS = 5 * 60_000;

/**
 * Supabase Auth access token → AdminPrincipal.
 * Sign-in itself (email + password, OAuth providers, TOTP 2FA) happens in the
 * admin portal against Supabase Auth; this backend never sees passwords.
 * Access is invite-only: the token's user must match an active AdminUser
 * (bound by Supabase user id, or by email on first login).
 */
@Injectable()
export class AdminAuthenticator {
  private readonly logger = new Logger(AdminAuthenticator.name);

  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly keys: JwksKeyResolver,
  ) {}

  async authenticate(bearer: string | undefined): Promise<AdminPrincipal> {
    if (!this.keys.configured && !this.config.get('SUPABASE_JWT_SECRET')) {
      throw new DomainError('UPSTREAM_UNAVAILABLE', 'Admin authentication is not configured');
    }
    const token = bearer?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) throw new DomainError('UNAUTHENTICATED', 'Missing bearer token');

    let claims;
    try {
      claims = await verifyJwt(token, {
        resolveKey: (kid, alg) => this.keys.resolve(kid, alg),
        hsSecret: this.config.get('SUPABASE_JWT_SECRET') ?? null,
        issuer: this.issuer(),
        audience: 'authenticated',
      });
    } catch (err) {
      if (err instanceof JwtError) throw new DomainError('UNAUTHENTICATED', `Invalid token: ${err.message}`);
      throw err;
    }
    if (claims.role !== 'authenticated' || claims.is_anonymous === true || !claims.sub || !UUID.test(claims.sub)) {
      throw new DomainError('UNAUTHENTICATED', 'Not a signed-in user token');
    }

    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null;
    let user = await this.prisma.adminUser.findUnique({ where: { authUserId: claims.sub } });
    if (!user && email) {
      const invited = await this.prisma.adminUser.findUnique({ where: { email } });
      if (invited && !invited.authUserId) {
        // First login: bind the invitation to this Supabase user (atomic, first wins).
        const bound = await this.prisma.adminUser.updateMany({ where: { id: invited.id, authUserId: null }, data: { authUserId: claims.sub } });
        if (bound.count === 1) {
          user = { ...invited, authUserId: claims.sub };
          this.logger.log(`Admin ${email} bound to Supabase user ${claims.sub}`);
        }
      }
    }
    if (!user || !user.active) throw new DomainError('FORBIDDEN', 'Not an active UNIMAK admin');

    const aal = typeof claims.aal === 'string' ? claims.aal : 'aal1';
    if (this.config.get('ADMIN_REQUIRE_MFA') && MFA_ROLES.includes(user.role) && aal !== 'aal2') {
      throw new DomainError('MFA_REQUIRED', 'Two-factor authentication is required for this role');
    }

    if (!user.lastLoginAt || Date.now() - user.lastLoginAt.getTime() > LAST_LOGIN_THROTTLE_MS) {
      await this.prisma.adminUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    }
    const scoped = isDepartmentScoped(user.role);
    const dean = user.role === 'DEAN';
    // A dean's departments are looked up on every request, so moving a department between faculties applies at once.
    const departments = !scoped ? [] : dean
      ? (await this.prisma.department.findMany({ where: { faculty: { code: { in: user.faculties } } }, select: { code: true }, orderBy: { code: 'asc' } })).map((d) => d.code)
      : user.departments;
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      permissions: effectivePermissions(user.role, user.extraPermissions),
      departments,
      faculties: dean ? user.faculties : [],
      departmentScoped: scoped,
      aal,
    };
  }

  private issuer(): string | null {
    const explicit = this.config.get('AUTH_JWT_ISSUER');
    if (explicit) return explicit;
    const base = this.config.get('SUPABASE_URL');
    return base ? `${base.replace(/\/+$/, '')}/auth/v1` : null;
  }
}
