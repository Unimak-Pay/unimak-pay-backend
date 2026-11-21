import { Module } from '@nestjs/common';
import { AcademicsModule } from '../academics/academics.module';
import { CatalogModule } from '../catalog/catalog.module';
import { LedgerModule } from '../ledger/ledger.module';
import { ApplyPortalEventsUseCase } from './application/apply-portal-events.use-case';
import { LookupPayerUseCase } from './application/lookup-payer.use-case';
import { ObligationSync } from './application/obligation-sync';
import { PayerDirectory } from './application/payer-directory';
import { PayerObligationsQuery } from './application/payer-obligations.query';
import { PAYER_REPOSITORY } from './application/payer.repository';
import { PrismaPayerRepository } from './infrastructure/prisma-payer.repository';

@Module({
  imports: [AcademicsModule, CatalogModule, LedgerModule],
  providers: [
    { provide: PAYER_REPOSITORY, useClass: PrismaPayerRepository },
    PayerDirectory,
    LookupPayerUseCase,
    ObligationSync,
    ApplyPortalEventsUseCase,
    PayerObligationsQuery,
  ],
  exports: [PAYER_REPOSITORY, LookupPayerUseCase, ObligationSync, ApplyPortalEventsUseCase, PayerObligationsQuery, PayerDirectory],
})
export class PayersModule {}
