import { Module } from '@nestjs/common';
import { AcademicsModule } from '../academics/academics.module';
import { CatalogModule } from '../catalog/catalog.module';
import { LedgerModule } from '../ledger/ledger.module';
import { LookupPayerUseCase } from './application/lookup-payer.use-case';
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
    PayerObligationsQuery,
  ],
  exports: [PAYER_REPOSITORY, LookupPayerUseCase, PayerObligationsQuery, PayerDirectory],
})
export class PayersModule {}
