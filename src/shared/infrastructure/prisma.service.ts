import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;
/** Anything that can run queries: the root client or an interactive transaction. */
export type Db = PrismaClient | Tx;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  /** Lazily connects on first query — important for serverless cold starts. */
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
