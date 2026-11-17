import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AppConfig } from '../../config/app-config';
import { safeEqual } from '../../shared/infrastructure/crypto';

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. */
@Injectable()
export class CronGuard implements CanActivate {
  constructor(private readonly config: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const auth = ctx.switchToHttp().getRequest<Request>().header('authorization') ?? '';
    if (!safeEqual(auth, `Bearer ${this.config.get('CRON_SECRET')}`)) throw new UnauthorizedException();
    return true;
  }
}
