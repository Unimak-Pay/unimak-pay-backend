import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { PaymentsModule } from '../payments/payments.module';
import { MonimeWebhookReceiver } from './application/monime-webhook.receiver';
import { WebhookInbox } from './infrastructure/webhook-inbox';
import { MonimeWebhookController } from './interface/monime-webhook.controller';

@Module({
  imports: [PaymentsModule, OutboxModule],
  controllers: [MonimeWebhookController],
  providers: [WebhookInbox, MonimeWebhookReceiver],
  exports: [MonimeWebhookReceiver],
})
export class WebhooksModule {}
