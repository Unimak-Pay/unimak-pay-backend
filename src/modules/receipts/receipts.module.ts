import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { ReceiptIssuer } from './application/receipt-issuer';
import { ReceiptsQuery } from './application/receipts.query';
import { ResendReceiptUseCase } from './application/resend-receipt.use-case';

@Module({
  imports: [OutboxModule],
  providers: [ReceiptIssuer, ReceiptsQuery, ResendReceiptUseCase],
  exports: [ReceiptIssuer, ReceiptsQuery, ResendReceiptUseCase],
})
export class ReceiptsModule {}
