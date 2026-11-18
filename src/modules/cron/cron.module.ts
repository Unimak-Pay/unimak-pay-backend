import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { PaymentsModule } from '../payments/payments.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { CronController } from './cron.controller';
import { CronGuard } from './cron.guard';

@Module({ imports: [OutboxModule, PaymentsModule, ReconciliationModule], controllers: [CronController], providers: [CronGuard] })
export class CronModule {}
