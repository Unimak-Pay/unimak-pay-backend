import { Module } from '@nestjs/common';
import { PayersModule } from '../payers/payers.module';
import { ClearanceService } from './application/clearance.service';
import { PaymentHistoryQuery } from './application/payment-history.query';
import { PayRequestsService } from './application/pay-requests.service';

/** Payment history, receipts, pay requests and exam clearance for the dot (docs/dot-extras.md). */
@Module({
  imports: [PayersModule],
  providers: [PayRequestsService, PaymentHistoryQuery, ClearanceService],
  exports: [PayRequestsService, PaymentHistoryQuery, ClearanceService],
})
export class DotExtrasModule {}
