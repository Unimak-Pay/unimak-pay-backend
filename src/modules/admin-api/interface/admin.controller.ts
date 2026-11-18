import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import type { AdminPrincipal } from '../../auth/application/admin-principal';
import { AdminAuthGuard, CurrentAdmin, RequirePermissions } from '../../auth/interface/admin-auth.guard';
import { MONIME_CLIENT, type MonimeClient } from '../../integrations/monime/monime.port';
import { ProvisionAccountsUseCase } from '../../treasury/application/provision-accounts.use-case';
import { RequestPayoutUseCase } from '../../treasury/application/request-payout.use-case';
import { AdminOpsService } from '../application/admin-ops.service';
import { AdminUsersService } from '../application/admin-users.service';
import { BigIntJsonInterceptor } from './bigint-json.interceptor';
import {
  AuditQuery, CreateAdminUserDto, CreatePayoutDto, PaymentsQuery, ResolveEventDto, StatusQuery, UpdateAdminUserDto,
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

  @Post('users')
  @RequirePermissions('users.manage')
  createUser(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: CreateAdminUserDto) {
    return this.users.create(admin, dto);
  }

  @Patch('users/:id')
  @RequirePermissions('users.manage')
  updateUser(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAdminUserDto) {
    return this.users.update(admin, id, dto);
  }

  // ── Payments ───────────────────────────────────────────────────────────────

  @Get('payments')
  @RequirePermissions('payments.read')
  listPayments(@CurrentAdmin() admin: AdminPrincipal, @Query() q: PaymentsQuery) {
    return this.ops.listPayments(admin, q);
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
  listPayouts(@Query() q: StatusQuery) {
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
  listTransfers(@Query() q: StatusQuery) {
    return this.ops.listTransfers(q);
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
  reconciliation() {
    return this.ops.reconciliationSummary();
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
  outbox(@Query() q: StatusQuery) {
    return this.ops.listOutbox(q);
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
