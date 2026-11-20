import { Module } from '@nestjs/common';
import { AcademicsService } from './application/academics.service';

/** Faculties and departments (reference list; the portal is the source of payer data). */
@Module({
  providers: [AcademicsService],
  exports: [AcademicsService],
})
export class AcademicsModule {}
