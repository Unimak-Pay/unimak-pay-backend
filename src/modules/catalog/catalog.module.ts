import { Module } from '@nestjs/common';
import { CATALOG_REPOSITORY } from './application/catalog.repository';
import { SaveRateRuleUseCase } from './application/save-rate-rule.use-case';
import { SetInstalmentRuleUseCase } from './application/set-instalment-rule.use-case';
import { PrismaCatalogRepository } from './infrastructure/prisma-catalog.repository';

@Module({
  providers: [
    { provide: CATALOG_REPOSITORY, useClass: PrismaCatalogRepository },
    SaveRateRuleUseCase,
    SetInstalmentRuleUseCase,
  ],
  exports: [CATALOG_REPOSITORY, SaveRateRuleUseCase, SetInstalmentRuleUseCase],
})
export class CatalogModule {}
