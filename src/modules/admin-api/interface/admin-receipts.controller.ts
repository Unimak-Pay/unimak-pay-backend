import { Controller, Get, Param, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import type { AdminPrincipal } from '../../auth/application/admin-principal';
import { AdminAuthGuard, CurrentAdmin, RequirePermissions } from '../../auth/interface/admin-auth.guard';
import { AdminReceiptsService } from '../application/admin-receipts.service';
import { BigIntJsonInterceptor } from './bigint-json.interceptor';
import { ReceiptsQuery } from './dto';

/** /v1/admin/receipts: newest first; heads of department and deans see their departments only. */
@Controller('v1/admin/receipts')
@UseGuards(AdminAuthGuard)
@UseInterceptors(BigIntJsonInterceptor)
export class AdminReceiptsController {
  constructor(private readonly receipts: AdminReceiptsService) {}

  @Get()
  @RequirePermissions('payments.read')
  list(@CurrentAdmin() admin: AdminPrincipal, @Query() q: ReceiptsQuery) {
    return this.receipts.list(admin, q);
  }

  /** By receipt number, e.g. UNIMAK-2026-000123 (case, spaces and dashes ignored). */
  @Get(':number')
  @RequirePermissions('payments.read')
  get(@CurrentAdmin() admin: AdminPrincipal, @Param('number') number: string) {
    return this.receipts.byNumber(admin, number.slice(0, 40));
  }
}
