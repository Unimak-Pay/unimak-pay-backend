import { Controller, Get, Param, ParseUUIDPipe, Query, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import type { AdminPrincipal } from '../../auth/application/admin-principal';
import { AdminAuthGuard, CurrentAdmin, RequirePermissions } from '../../auth/interface/admin-auth.guard';
import { AdminAnalyticsService } from '../application/admin-analytics.service';
import { AdminPortalService } from '../application/admin-portal.service';
import { BigIntJsonInterceptor } from './bigint-json.interceptor';
import { NeedsReviewQuery, OutstandingQuery, PayersExportQuery, PayersQuery } from './dto';

/**
 * /v1/admin payer analytics (docs/analytics.md). Heads of department and deans
 * only ever see their own departments. The fixed payers/… routes are declared
 * before payers/:id.
 */
@Controller('v1/admin')
@UseGuards(AdminAuthGuard)
@UseInterceptors(BigIntJsonInterceptor)
export class AdminPayersController {
  constructor(
    private readonly analytics: AdminAnalyticsService,
    private readonly portal: AdminPortalService,
  ) {}

  /** Billed, collected and outstanding by department × level. */
  @Get('reports/outstanding')
  @RequirePermissions('reports.read')
  outstanding(@CurrentAdmin() admin: AdminPrincipal, @Query() q: OutstandingQuery) {
    return this.analytics.outstanding(admin, q);
  }

  /** Suspended, withdrawn or graduated students who still owe something. */
  @Get('payers/needs-review')
  @RequirePermissions('payers.read')
  needsReview(@CurrentAdmin() admin: AdminPrincipal, @Query() q: NeedsReviewQuery) {
    return this.portal.needsReview(admin, q);
  }

  /** CSV of the payer list (phones masked); audited. */
  @Get('payers/export.csv')
  @RequirePermissions('payers.read', 'payments.export')
  async exportPayers(@CurrentAdmin() admin: AdminPrincipal, @Query() q: PayersExportQuery, @Res() res: Response): Promise<void> {
    const rows = this.analytics.exportPayers(admin, q);
    const first = await rows.next(); // throws (→ JSON error) before any header is sent
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="unimak-payers-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    if (!first.done) res.write(`﻿${first.value}`); // BOM so Excel reads UTF-8
    for await (const chunk of rows) res.write(chunk);
    res.end();
  }

  /** Students and applicants with what they've been billed, paid and still owe. */
  @Get('payers')
  @RequirePermissions('payers.read')
  listPayers(@CurrentAdmin() admin: AdminPrincipal, @Query() q: PayersQuery) {
    return this.analytics.listPayers(admin, q);
  }

  /** One payer: record (full phone), obligations, ledger, payments, receipts, portal events. */
  @Get('payers/:id')
  @RequirePermissions('payers.read')
  getPayer(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.analytics.getPayer(admin, id);
  }
}
