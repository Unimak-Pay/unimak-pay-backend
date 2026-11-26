import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import type { AdminPrincipal } from '../../auth/application/admin-principal';
import { AdminAuthGuard, CurrentAdmin, RequirePermissions } from '../../auth/interface/admin-auth.guard';
import { ClearanceService } from '../../dot-extras/application/clearance.service';
import { ClearancePolicyDto } from './dto';

/** The finance office's exam-clearance rule (docs/dot-extras.md §4). */
@Controller('v1/admin/clearance-policy')
@UseGuards(AdminAuthGuard)
export class AdminClearanceController {
  constructor(private readonly clearance: ClearanceService) {}

  @Get()
  @RequirePermissions('fees.read')
  get() {
    return this.clearance.policy();
  }

  /** Replaces the rule (and clears the placeholder flag); audited. */
  @Put()
  @RequirePermissions('clearance.manage')
  put(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: ClearancePolicyDto) {
    return this.clearance.setPolicy(admin.id, dto);
  }
}
