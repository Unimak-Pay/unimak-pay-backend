import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { LedgerModule } from '../ledger/ledger.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ReceiptsModule } from '../receipts/receipts.module';
import { ExpirePaymentsUseCase } from './application/expire-payments.use-case';
import { InitiatePaymentUseCase } from './application/initiate-payment.use-case';
import { PaymentEvaluator } from './application/payment-evaluator';
import { PAYMENT_REPOSITORY } from './application/payment.repository';
import { QuotePaymentUseCase } from './application/quote-payment.use-case';
import { SettlePaymentService } from './application/settle-payment.service';
import { PrismaPaymentRepository } from './infrastructure/prisma-payment.repository';

@Module({
  imports: [CatalogModule, LedgerModule, ReceiptsModule, OutboxModule],
  providers: [
    { provide: PAYMENT_REPOSITORY, useClass: PrismaPaymentRepository },
    PaymentEvaluator,
    QuotePaymentUseCase,
    InitiatePaymentUseCase,
    ExpirePaymentsUseCase,
    SettlePaymentService,
  ],
  exports: [PAYMENT_REPOSITORY, QuotePaymentUseCase, InitiatePaymentUseCase, ExpirePaymentsUseCase, SettlePaymentService],
})
export class PaymentsModule {}
