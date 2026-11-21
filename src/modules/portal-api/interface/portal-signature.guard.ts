import { type CanActivate, type ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AppConfig } from '../../../config/app-config';
import { hmacSha256Hex, safeEqual } from '../../../shared/infrastructure/crypto';

export const PORTAL_MAX_SKEW_SECONDS = 300;

/**
 * docs/portal-events.md A2:
 *   X-Portal-Timestamp: unix seconds, within ±300 s
 *   X-Portal-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
 * The current and the previous secret are both accepted (rotation).
 */
@Injectable()
export class PortalSignatureGuard implements CanActivate {
  constructor(private readonly config: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const secrets = [this.config.get('PORTAL_EVENTS_SECRET'), this.config.get('PORTAL_EVENTS_SECRET_PREVIOUS')].filter((s): s is string => !!s);
    if (!secrets.length) throw new ServiceUnavailableException('Portal events are not configured');

    const req = ctx.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const ts = req.header('x-portal-timestamp');
    const sig = req.header('x-portal-signature')?.trim().toLowerCase();
    if (!ts || !sig) throw new UnauthorizedException('Missing X-Portal-Timestamp or X-Portal-Signature');
    if (!/^\d{1,12}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > PORTAL_MAX_SKEW_SECONDS) {
      throw new UnauthorizedException('Timestamp outside the allowed window');
    }
    if (!/^v1=[0-9a-f]{64}$/.test(sig)) throw new UnauthorizedException('Bad signature');
    const payload = `${ts}.${req.rawBody?.toString('utf8') ?? ''}`;
    if (!secrets.some((s) => safeEqual(`v1=${hmacSha256Hex(s, payload)}`, sig))) throw new UnauthorizedException('Bad signature');
    return true;
  }
}
