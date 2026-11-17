import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { DevMonimeController } from './dev-monime.controller';

/** Only imported when NODE_ENV !== 'production' (see AppModule). */
@Module({ imports: [PaymentsModule, WebhooksModule], controllers: [DevMonimeController] })
export class DevModule {}
