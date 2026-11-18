import { Module } from '@nestjs/common';
import { PayersModule } from '../payers/payers.module';
import { PaymentsModule } from '../payments/payments.module';
import { ReceiptsModule } from '../receipts/receipts.module';
import { UssdFlowService } from './application/ussd-flow.service';
import { UssdKeys } from './application/ussd-keys';
import { UssdExchangeController } from './interface/ussd-exchange.controller';

/** Monime USSD flow exchange endpoint (RSA-OAEP + AES-128-GCM). */
@Module({
  imports: [PayersModule, PaymentsModule, ReceiptsModule],
  controllers: [UssdExchangeController],
  providers: [UssdKeys, UssdFlowService],
})
export class UssdModule {}
