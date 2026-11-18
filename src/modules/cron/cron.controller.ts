import { Controller, Get, UseGuards } from '@nestjs/common';
import { OutboxDispatcher } from '../outbox/application/outbox-dispatcher';
import { ExpirePaymentsUseCase } from '../payments/application/expire-payments.use-case';
import { PrismaService } from '../../shared/infrastructure/prisma.service';
import { NightlyReconciliationService } from '../reconciliation/application/nightly-reconciliation.service';
import { CronGuard } from './cron.guard';

@Controller('cron')
@UseGuards(CronGuard)
export class CronController {
  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly expire: ExpirePaymentsUseCase,
    private readonly prisma: PrismaService,
    private readonly reconciliation: NightlyReconciliationService,
  ) {}

  @Get('outbox')
  async outbox() {
    // A few batches per invocation; stays well within the function timeout.
    const total = { claimed: 0, sent: 0, retried: 0, dead: 0 };
    for (let i = 0; i < 5; i++) {
      const s = await this.dispatcher.sweep(50);
      for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += s[k];
      if (s.claimed < 50) break;
    }
    return total;
  }

  /** Nightly: compare yesterday (UTC) with Monime. */
  @Get('reconcile')
  reconcile() {
    return this.reconciliation.runNightly();
  }

  @Get('expire-payments')
  async expirePayments() {
    const expired = await this.expire.execute();
    const { count: ussdSessions } = await this.prisma.ussdSession.deleteMany({ where: { updatedAt: { lt: new Date(Date.now() - 24 * 60 * 60_000) } } });
    return { expired, ussdSessionsDeleted: ussdSessions };
  }
}
