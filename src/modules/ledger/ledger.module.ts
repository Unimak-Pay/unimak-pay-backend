import { Module } from '@nestjs/common';
import { LEDGER_REPOSITORY } from './application/ledger.repository';
import { PrismaLedgerRepository } from './infrastructure/prisma-ledger.repository';

@Module({
  providers: [{ provide: LEDGER_REPOSITORY, useClass: PrismaLedgerRepository }],
  exports: [LEDGER_REPOSITORY],
})
export class LedgerModule {}
