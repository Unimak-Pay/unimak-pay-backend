import { Module } from '@nestjs/common';
import { PayersModule } from '../payers/payers.module';
import { PayRequestsService } from './application/pay-requests.service';

/** Payment history, receipts, pay requests and exam clearance for the dot (docs/dot-extras.md). */
@Module({
  imports: [PayersModule],
  providers: [PayRequestsService],
  exports: [PayRequestsService],
})
export class DotExtrasModule {}
