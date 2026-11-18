import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { ReceiptIssuer } from './application/receipt-issuer';
import { ReceiptsQuery } from './application/receipts.query';

@Module({
  imports: [OutboxModule],
  providers: [ReceiptIssuer, ReceiptsQuery],
  exports: [ReceiptIssuer, ReceiptsQuery],
})
export class ReceiptsModule {}
