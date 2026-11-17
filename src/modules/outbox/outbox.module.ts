import { Module } from '@nestjs/common';
import { TreasuryModule } from '../treasury/treasury.module';
import { OutboxDispatcher } from './application/outbox-dispatcher';
import { OUTBOX_HANDLERS } from './application/outbox-handler';
import { OutboxWriter } from './application/outbox-writer';
import {
  CommissionTransferHandler,
  PortalApplicationPaidHandler,
  SmsReceiptHandler,
} from './infrastructure/handlers';

@Module({
  imports: [TreasuryModule],
  providers: [
    OutboxWriter,
    OutboxDispatcher,
    SmsReceiptHandler,
    PortalApplicationPaidHandler,
    CommissionTransferHandler,
    {
      provide: OUTBOX_HANDLERS,
      inject: [SmsReceiptHandler, PortalApplicationPaidHandler, CommissionTransferHandler],
      useFactory: (...handlers: unknown[]) => handlers,
    },
  ],
  exports: [OutboxWriter, OutboxDispatcher],
})
export class OutboxModule {}
