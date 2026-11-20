import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { AcademicsService } from '../../academics/application/academics.service';
import type { AdminPrincipal } from '../../auth/application/admin-principal';
import { AdminAuthGuard, CurrentAdmin, RequirePermissions } from '../../auth/interface/admin-auth.guard';
import { BigIntJsonInterceptor } from './bigint-json.interceptor';
import { CreateDepartmentDto, CreateFacultyDto, DepartmentsQuery, UpdateDepartmentDto, UpdateFacultyDto } from './dto';

/**
 * Faculties → departments. Any admin can read them (dropdowns); changes need
 * academics.manage. Codes never change and nothing is deleted.
 */
@Controller('v1/admin')
@UseGuards(AdminAuthGuard)
@UseInterceptors(BigIntJsonInterceptor)
export class AdminAcademicsController {
  constructor(private readonly academics: AcademicsService) {}

  @Get('faculties')
  faculties() {
    return this.academics.listFaculties();
  }

  @Post('faculties')
  @RequirePermissions('academics.manage')
  createFaculty(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: CreateFacultyDto) {
    return this.academics.createFaculty(admin.id, dto);
  }

  @Patch('faculties/:code')
  @RequirePermissions('academics.manage')
  updateFaculty(@CurrentAdmin() admin: AdminPrincipal, @Param('code') code: string, @Body() dto: UpdateFacultyDto) {
    return this.academics.updateFaculty(admin.id, code, dto);
  }

  @Get('departments')
  departments(@Query() q: DepartmentsQuery) {
    return this.academics.listDepartments(q);
  }

  @Get('departments/:code')
  department(@Param('code') code: string) {
    return this.academics.getDepartment(code);
  }

  @Post('departments')
  @RequirePermissions('academics.manage')
  createDepartment(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: CreateDepartmentDto) {
    return this.academics.createDepartment(admin.id, dto);
  }

  @Patch('departments/:code')
  @RequirePermissions('academics.manage')
  updateDepartment(@CurrentAdmin() admin: AdminPrincipal, @Param('code') code: string, @Body() dto: UpdateDepartmentDto) {
    return this.academics.updateDepartment(admin.id, code, dto);
  }
}
