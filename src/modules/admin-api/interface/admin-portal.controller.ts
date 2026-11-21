import { Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import type { AdminPrincipal } from '../../auth/application/admin-principal';
import { AdminAuthGuard, CurrentAdmin, RequirePermissions } from '../../auth/interface/admin-auth.guard';
import { AdminPortalService } from '../application/admin-portal.service';
import { BigIntJsonInterceptor } from './bigint-json.interceptor';
import { NeedsReviewQuery, PortalEventsQuery } from './dto';

/** /v1/admin views of the portal sync. */
@Controller('v1/admin')
@UseGuards(AdminAuthGuard)
@UseInterceptors(BigIntJsonInterceptor)
export class AdminPortalController {
  constructor(private readonly portal: AdminPortalService) {}

  /** What the portal sent and what we did with it (names and phones: portal.read). */
  @Get('portal-events')
  @RequirePermissions('portal.read')
  events(@Query() q: PortalEventsQuery) {
    return this.portal.events(q);
  }

  /** Suspended, withdrawn or graduated students who still owe something. */
  @Get('payers/needs-review')
  @RequirePermissions('payers.read')
  needsReview(@CurrentAdmin() admin: AdminPrincipal, @Query() q: NeedsReviewQuery) {
    return this.portal.needsReview(admin, q);
  }
}
