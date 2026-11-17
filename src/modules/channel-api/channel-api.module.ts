import { Module } from '@nestjs/common';
import { PayersModule } from '../payers/payers.module';
import { PaymentsModule } from '../payments/payments.module';
import { ReceiptsModule } from '../receipts/receipts.module';
import { ChannelClients } from './application/channel-clients';
import { ChannelAuthGuard } from './interface/channel-auth.guard';
import { ChannelController } from './interface/channel.controller';
import { PublicReceiptController } from './interface/public-receipt.controller';

@Module({
  imports: [PayersModule, PaymentsModule, ReceiptsModule],
  controllers: [ChannelController, PublicReceiptController],
  providers: [ChannelClients, ChannelAuthGuard],
})
export class ChannelApiModule {}
