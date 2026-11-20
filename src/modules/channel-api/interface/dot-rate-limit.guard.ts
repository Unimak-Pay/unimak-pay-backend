import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppConfig } from '../../../config/app-config';
import { DomainError } from '../../../shared/domain/errors';
import { FixedWindowLimiter } from '../../../shared/domain/rate-limiter';

/** Vercel sets x-real-ip to the caller's address (clients can't override it there). */
export function clientIp(req: Request): string {
  const real = req.header('x-real-ip');
  if (real) return real.trim();
  const fwd = req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

/** Per-IP brake on the public dot API (DOT_RATE_LIMIT_PER_MINUTE). */
@Injectable()
export class DotRateLimitGuard implements CanActivate {
  private readonly limiter: FixedWindowLimiter;

  constructor(config: AppConfig) {
    this.limiter = new FixedWindowLimiter(config.get('DOT_RATE_LIMIT_PER_MINUTE'), 60_000);
  }

  canActivate(ctx: ExecutionContext): boolean {
    const http = ctx.switchToHttp();
    const ip = clientIp(http.getRequest<Request>());
    if (this.limiter.hit(ip)) return true;
    http.getResponse<Response>().setHeader('Retry-After', String(this.limiter.retryAfter(ip)));
    throw new DomainError('RATE_LIMITED', 'Too many requests, try again in a minute');
  }
}
