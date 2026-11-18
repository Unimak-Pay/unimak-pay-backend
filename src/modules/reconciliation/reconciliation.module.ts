import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { PaymentsModule } from '../payments/payments.module';
import { NightlyReconciliationService } from './application/nightly-reconciliation.service';

@Module({
  imports: [PaymentsModule, OutboxModule],
  providers: [NightlyReconciliationService],
  exports: [NightlyReconciliationService],
})
export class ReconciliationModule {}
