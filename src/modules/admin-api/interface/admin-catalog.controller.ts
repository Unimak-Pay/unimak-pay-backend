import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import type { AdminPrincipal } from '../../auth/application/admin-principal';
import { AdminAuthGuard, CurrentAdmin, RequirePermissions } from '../../auth/interface/admin-auth.guard';
import type { Matchers } from '../../catalog/domain/matchers';
import { AdminCatalogService } from '../application/admin-catalog.service';
import { BigIntJsonInterceptor } from './bigint-json.interceptor';
import {
  CreateFeeDto, CreateFeeTypeDto, EligibilityRuleDto, FeesQuery, InstalmentRuleDto, PreviewQuery, RateRuleDto, UpdateFeeDto, UpdateFeeTypeDto,
} from './catalog.dto';

const matchers = (d: Partial<Matchers>): Matchers => ({
  programCode: d.programCode ?? null,
  department: d.department ?? null,
  level: d.level ?? null,
  residency: d.residency ?? null,
  intake: d.intake ?? null,
});

/** /v1/admin fee setup: fee types (with their Monime account), fees, rules, preview. */
@Controller('v1/admin')
@UseGuards(AdminAuthGuard)
@UseInterceptors(BigIntJsonInterceptor)
export class AdminCatalogController {
  constructor(private readonly catalog: AdminCatalogService) {}

  // ── Fee types ──────────────────────────────────────────────────────────────

  @Get('fee-types')
  @RequirePermissions('fees.read')
  feeTypes() {
    return this.catalog.listFeeTypes();
  }

  /** Creates the fee type and its own Monime financial account. */
  @Post('fee-types')
  @HttpCode(201)
  @RequirePermissions('fees.manage')
  createFeeType(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: CreateFeeTypeDto) {
    return this.catalog.createFeeType(admin, dto);
  }

  @Patch('fee-types/:id')
  @RequirePermissions('fees.manage')
  renameFeeType(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFeeTypeDto) {
    return this.catalog.renameFeeType(admin, id, dto.name);
  }

  /** Creates (or links) the fee type's Monime account if it's missing — e.g. Monime was down at creation. */
  @Post('fee-types/:id/account')
  @HttpCode(200)
  @RequirePermissions('fees.manage')
  feeTypeAccount(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.ensureFeeTypeAccount(admin, id);
  }

  // ── Fees ───────────────────────────────────────────────────────────────────

  @Get('fees')
  @RequirePermissions('fees.read')
  async fees(@Query() q: FeesQuery) {
    return (await this.catalog.listFees(q)).map(dueDateOnly);
  }

  @Get('fees/:id')
  @RequirePermissions('fees.read')
  async fee(@Param('id', ParseUUIDPipe) id: string) {
    return dueDateOnly(await this.catalog.getFee(id));
  }

  @Post('fees')
  @HttpCode(201)
  @RequirePermissions('fees.manage')
  async createFee(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: CreateFeeDto) {
    return dueDateOnly(await this.catalog.createFee(admin, {
      feeTypeId: dto.feeTypeId, name: dto.name, period: dto.period, allowInstalments: dto.allowInstalments,
      ...(dto.defaultMinInstalment ? { defaultMinInstalment: BigInt(dto.defaultMinInstalment) } : {}),
      ...(dto.dueDate ? { dueDate: new Date(dto.dueDate) } : {}),
    }));
  }

  @Patch('fees/:id')
  @RequirePermissions('fees.manage')
  async updateFee(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFeeDto) {
    return dueDateOnly(await this.catalog.updateFee(admin, id, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.allowInstalments !== undefined ? { allowInstalments: dto.allowInstalments } : {}),
      ...(dto.defaultMinInstalment !== undefined ? { defaultMinInstalment: dto.defaultMinInstalment === null ? null : BigInt(dto.defaultMinInstalment) } : {}),
      ...(dto.dueDate !== undefined ? { dueDate: dto.dueDate === null ? null : new Date(dto.dueDate) } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
    }));
  }

  /** What a given student / applicant would owe for this fee (live portal lookup, no writes). */
  @Get('fees/:id/preview')
  @RequirePermissions('fees.read')
  preview(@Param('id', ParseUUIDPipe) id: string, @Query() q: PreviewQuery) {
    return this.catalog.preview(id, q.kind === 'student' ? 'STUDENT' : 'APPLICANT', q.ref.toUpperCase());
  }

  // ── Rate rules ─────────────────────────────────────────────────────────────

  @Post('fees/:id/rate-rules')
  @HttpCode(201)
  @RequirePermissions('fees.manage')
  addRateRule(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RateRuleDto) {
    return this.catalog.saveRateRule(admin, id, { ...matchers(dto), amount: BigInt(dto.amount) });
  }

  @Put('fees/:id/rate-rules/:ruleId')
  @RequirePermissions('fees.manage')
  updateRateRule(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Param('ruleId', ParseUUIDPipe) ruleId: string, @Body() dto: RateRuleDto) {
    return this.catalog.saveRateRule(admin, id, { ...matchers(dto), amount: BigInt(dto.amount) }, ruleId);
  }

  @Delete('fees/:id/rate-rules/:ruleId')
  @RequirePermissions('fees.manage')
  deleteRateRule(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Param('ruleId', ParseUUIDPipe) ruleId: string) {
    return this.catalog.deleteRateRule(admin, id, ruleId);
  }

  // ── Eligibility ────────────────────────────────────────────────────────────

  @Post('fees/:id/eligibility-rules')
  @HttpCode(201)
  @RequirePermissions('fees.manage')
  addEligibility(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EligibilityRuleDto) {
    return this.catalog.addEligibilityRule(admin, id, { ...matchers(dto), finalYear: dto.finalYear ?? null });
  }

  @Delete('fees/:id/eligibility-rules/:ruleId')
  @RequirePermissions('fees.manage')
  deleteEligibility(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Param('ruleId', ParseUUIDPipe) ruleId: string) {
    return this.catalog.deleteEligibilityRule(admin, id, ruleId);
  }

  // ── Minimum instalment per department (instalments.manage) ─────────────────

  @Put('fees/:id/instalment-rules/:department')
  @RequirePermissions('instalments.manage')
  setInstalment(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Param('department') department: string, @Body() dto: InstalmentRuleDto) {
    return this.catalog.setInstalmentRule(admin, id, department, BigInt(dto.minInstalment));
  }

  @Delete('fees/:id/instalment-rules/:department')
  @RequirePermissions('instalments.manage')
  deleteInstalment(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Param('department') department: string) {
    return this.catalog.deleteInstalmentRule(admin, id, department);
  }
}

/** Fee.dueDate is a calendar day: YYYY-MM-DD, as it is sent. */
function dueDateOnly<T extends { dueDate: Date | null }>(fee: T): Omit<T, 'dueDate'> & { dueDate: string | null } {
  return { ...fee, dueDate: fee.dueDate ? fee.dueDate.toISOString().slice(0, 10) : null };
}
