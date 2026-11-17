import { Controller, Get, UseGuards } from '@nestjs/common';
import { OutboxDispatcher } from '../outbox/application/outbox-dispatcher';
import { ExpirePaymentsUseCase } from '../payments/application/expire-payments.use-case';
import { CronGuard } from './cron.guard';

@Controller('cron')
@UseGuards(CronGuard)
export class CronController {
  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly expire: ExpirePaymentsUseCase,
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

  @Get('expire-payments')
  async expirePayments() {
    return { expired: await this.expire.execute() };
  }
}
