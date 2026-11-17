import { Inject, Injectable } from '@nestjs/common';
import { MONIME_CLIENT, type MonimeClient } from '../../integrations/monime/monime.port';
import { PORTAL_CLIENT, type PortalClient } from '../../integrations/portal/portal.port';
import { SMS_SENDER, type SmsSender } from '../../integrations/sms/sms.port';
import type { OutboxHandler } from '../application/outbox-handler';
import type {
  CommissionTransferPayload,
  PortalApplicationPaidPayload,
  SmsReceiptPayload,
} from '../domain/messages';

@Injectable()
export class SmsReceiptHandler implements OutboxHandler<'sms.receipt'> {
  readonly type = 'sms.receipt' as const;
  constructor(@Inject(SMS_SENDER) private readonly sms: SmsSender) {}
  handle(p: SmsReceiptPayload): Promise<void> {
    return this.sms.send(p.phone, p.text);
  }
}

@Injectable()
export class PortalApplicationPaidHandler implements OutboxHandler<'portal.application_paid'> {
  readonly type = 'portal.application_paid' as const;
  constructor(@Inject(PORTAL_CLIENT) private readonly portal: PortalClient) {}
  handle(p: PortalApplicationPaidPayload): Promise<void> {
    return this.portal.notifyPayment({ event: 'application_paid', currency: 'SLE', ...p });
  }
}

/** Idempotent on the payment id (used as Monime idempotency key). */
@Injectable()
export class CommissionTransferHandler implements OutboxHandler<'monime.commission_transfer'> {
  readonly type = 'monime.commission_transfer' as const;
  constructor(@Inject(MONIME_CLIENT) private readonly monime: MonimeClient) {}
  async handle(p: CommissionTransferPayload): Promise<void> {
    await this.monime.transfer({
      idempotencyKey: p.paymentId,
      fromAccount: p.fromAccount,
      toAccount: p.toAccount,
      amount: BigInt(p.amount),
      currency: 'SLE',
      description: `UNIMAK platform commission ${p.paymentId}`,
    });
  }
}
