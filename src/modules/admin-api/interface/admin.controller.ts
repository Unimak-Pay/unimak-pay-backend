import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import type { AdminPrincipal } from '../../auth/application/admin-principal';
import { AdminAuthGuard, CurrentAdmin, RequirePermissions } from '../../auth/interface/admin-auth.guard';
import { MONIME_CLIENT, type MonimeClient } from '../../integrations/monime/monime.port';
import { ProvisionAccountsUseCase } from '../../treasury/application/provision-accounts.use-case';
import { RequestPayoutUseCase } from '../../treasury/application/request-payout.use-case';
import { AdminOpsService } from '../application/admin-ops.service';
import { AdminReportsService } from '../application/admin-reports.service';
import { AdminUsersService } from '../application/admin-users.service';
import { BigIntJsonInterceptor } from './bigint-json.interceptor';
import {
  AuditQuery, CreateAdminUserDto, CreatePayoutDto, ItemsQuery, OutboxQuery, PaymentsExportQuery, PaymentsQuery, PayoutsQuery, ReportsSummaryQueryDto,
  RunReconciliationDto, ResolveEventDto, RunsQuery, TransfersQuery, UpdateAdminUserDto, WebhookEventsQuery,
} from './dto';

/**
 * /v1/admin — Authorization: Bearer <Supabase Auth access token>.
 * Each route lists the permissions it needs; roles are permission bundles.
 */
@Controller('v1/admin')
@UseGuards(AdminAuthGuard)
@UseInterceptors(BigIntJsonInterceptor)
export class AdminController {
  constructor(
    private readonly ops: AdminOpsService,
    private readonly users: AdminUsersService,
    private readonly reports: AdminReportsService,
    private readonly provision: ProvisionAccountsUseCase,
    private readonly payouts: RequestPayoutUseCase,
    @Inject(MONIME_CLIENT) private readonly monime: MonimeClient,
  ) {}

  @Get('me')
  me(@CurrentAdmin() admin: AdminPrincipal) {
    return { ...admin, permissions: [...admin.permissions].sort() };
  }

  // ── Admin users ────────────────────────────────────────────────────────────

  @Get('users')
  @RequirePermissions('users.manage')
  listUsers() {
    return this.users.list();
  }

  @Get('users/:id')
  @RequirePermissions('users.manage')
  getUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(id);
  }

  @Post('users')
  @RequirePermissions('users.manage')
  createUser(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: CreateAdminUserDto) {
    return this.users.create(admin, dto);
  }

  /** Re-sends the Supabase invite email (only before their first sign-in). */
  @Post('users/:id/invite')
  @HttpCode(200)
  @RequirePermissions('users.manage')
  resendInvite(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.resendInvite(admin, id);
  }

  @Patch('users/:id')
  @RequirePermissions('users.manage')
  updateUser(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAdminUserDto) {
    return this.users.update(admin, id, dto);
  }

  // ── Reports ────────────────────────────────────────────────────────────────

  /** Collection totals: by day, fee type and channel; payment funnel; commission and payouts. */
  @Get('reports/summary')
  @RequirePermissions('reports.read')
  reportsSummary(@CurrentAdmin() admin: AdminPrincipal, @Query() q: ReportsSummaryQueryDto) {
    return this.reports.summary(admin, q);
  }

  // ── Payments ───────────────────────────────────────────────────────────────

  @Get('payments')
  @RequirePermissions('payments.read')
  listPayments(@CurrentAdmin() admin: AdminPrincipal, @Query() q: PaymentsQuery) {
    return this.ops.listPayments(admin, q);
  }

  /** CSV (SLE amounts) of the payments matching the list filters; audited. Declared before payments/:id. */
  @Get('payments/export.csv')
  @RequirePermissions('payments.export')
  async exportPayments(@CurrentAdmin() admin: AdminPrincipal, @Query() q: PaymentsExportQuery, @Res() res: Response): Promise<void> {
    const rows = this.ops.exportPayments(admin, q);
    const first = await rows.next(); // throws (→ JSON error) before any header is sent, e.g. too many rows
    const day = new Date().toISOString().slice(0, 10);
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="unimak-payments-${day}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    if (!first.done) res.write(`\uFEFF${first.value}`); // BOM so Excel reads UTF-8
    for await (const chunk of rows) res.write(chunk);
    res.end();
  }

  @Get('payments/:id')
  @RequirePermissions('payments.read')
  getPayment(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.ops.getPayment(admin, id);
  }

  /** Ask Monime about an open payment; closes it if its payment code expired/was cancelled. */
  @Post('payments/:id/reconcile')
  @HttpCode(200)
  @RequirePermissions('payments.reconcile')
  reconcilePayment(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.ops.reconcilePayment(admin, id);
  }

  // ── Financial accounts ─────────────────────────────────────────────────────

  @Get('financial-accounts')
  @RequirePermissions('accounts.read')
  listAccounts() {
    return this.ops.listAccounts();
  }

  @Post('financial-accounts/provision')
  @HttpCode(200)
  @RequirePermissions('accounts.manage')
  provisionAccounts(@CurrentAdmin() admin: AdminPrincipal) {
    return this.provision.execute({ actorId: admin.id });
  }

  @Post('financial-accounts/:id/refresh-balance')
  @HttpCode(200)
  @RequirePermissions('accounts.read')
  refreshBalance(@Param('id', ParseUUIDPipe) id: string) {
    return this.ops.refreshBalance(id);
  }

  // ── Payouts ────────────────────────────────────────────────────────────────

  @Get('banks')
  @RequirePermissions('payouts.read')
  banks() {
    return this.monime.listBanks('SL');
  }

  @Get('payouts')
  @RequirePermissions('payouts.read')
  listPayouts(@Query() q: PayoutsQuery) {
    return this.ops.listPayouts(q);
  }

  @Get('payouts/:id')
  @RequirePermissions('payouts.read')
  getPayout(@Param('id', ParseUUIDPipe) id: string) {
    return this.ops.getPayout(id);
  }

  @Post('payouts')
  @HttpCode(201)
  @RequirePermissions('payouts.manage')
  createPayout(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: CreatePayoutDto) {
    return this.payouts.execute(
      { id: admin.id, permissions: [...admin.permissions] },
      { ...dto, amount: BigInt(dto.amount) },
    );
  }

  // ── Commission transfers ───────────────────────────────────────────────────

  @Get('transfers')
  @RequirePermissions('transfers.read')
  listTransfers(@Query() q: TransfersQuery) {
    return this.ops.listTransfers(q);
  }

  @Get('transfers/:id')
  @RequirePermissions('transfers.read')
  getTransfer(@Param('id', ParseUUIDPipe) id: string) {
    return this.ops.getTransfer(id);
  }

  @Post('transfers/:id/retry')
  @HttpCode(200)
  @RequirePermissions('transfers.retry')
  retryTransfer(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.ops.retryTransfer(admin, id);
  }

  // ── Reconciliation & outbox ────────────────────────────────────────────────

  @Get('reconciliation')
  @RequirePermissions('reconciliation.read')
  reconciliation(@CurrentAdmin() admin: AdminPrincipal) {
    return this.ops.reconciliationSummary(admin);
  }

  @Get('reconciliation/runs')
  @RequirePermissions('reconciliation.read')
  runs(@Query() q: RunsQuery) {
    return this.ops.listRuns(q);
  }

  @Get('reconciliation/runs/:id')
  @RequirePermissions('reconciliation.read')
  run(@Param('id', ParseUUIDPipe) id: string) {
    return this.ops.getRun(id);
  }

  /** Runs the Monime comparison now for a UTC day (default yesterday). */
  @Post('reconciliation/runs')
  @HttpCode(201)
  @RequirePermissions('reconciliation.manage')
  startRun(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: RunReconciliationDto) {
    return this.ops.runReconciliation(admin, dto.date);
  }

  @Get('reconciliation/items')
  @RequirePermissions('reconciliation.read')
  items(@Query() q: ItemsQuery) {
    return this.ops.listItems(q);
  }

  @Post('reconciliation/items/:id/resolve')
  @HttpCode(200)
  @RequirePermissions('reconciliation.manage')
  resolveItem(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveEventDto) {
    return this.ops.resolveItem(admin, id, dto.resolution);
  }

  @Get('reconciliation/webhook-events')
  @RequirePermissions('reconciliation.read')
  webhookEvents(@Query() q: WebhookEventsQuery) {
    return this.ops.listWebhookEvents(q);
  }

  @Get('reconciliation/webhook-events/:id')
  @RequirePermissions('reconciliation.read')
  webhookEvent(@Param('id') id: string) {
    return this.ops.getWebhookEvent(id);
  }

  @Post('reconciliation/webhook-events/:id/resolve')
  @HttpCode(200)
  @RequirePermissions('reconciliation.manage')
  resolveEvent(@CurrentAdmin() admin: AdminPrincipal, @Param('id') id: string, @Body() dto: ResolveEventDto) {
    return this.ops.resolveWebhookEvent(admin, id, dto.resolution);
  }

  @Post('reconciliation/webhook-events/:id/replay')
  @HttpCode(200)
  @RequirePermissions('reconciliation.manage')
  replayEvent(@CurrentAdmin() admin: AdminPrincipal, @Param('id') id: string) {
    return this.ops.replayWebhookEvent(admin, id);
  }

  @Get('outbox')
  @RequirePermissions('outbox.read')
  outbox(@CurrentAdmin() admin: AdminPrincipal, @Query() q: OutboxQuery) {
    return this.ops.listOutbox(admin, q);
  }

  @Get('outbox/:id')
  @RequirePermissions('outbox.read')
  getOutbox(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.ops.getOutbox(admin, id);
  }

  @Post('outbox/:id/retry')
  @HttpCode(200)
  @RequirePermissions('outbox.retry')
  retryOutbox(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.ops.retryOutbox(admin, id);
  }

  // ── Audit ──────────────────────────────────────────────────────────────────

  @Get('audit-log')
  @RequirePermissions('audit.read')
  auditLog(@Query() q: AuditQuery) {
    return this.ops.auditLog(q);
  }

}
