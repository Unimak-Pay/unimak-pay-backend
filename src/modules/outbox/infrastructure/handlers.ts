import { Inject, Injectable } from '@nestjs/common';
import { PORTAL_CLIENT, type PortalClient } from '../../integrations/portal/portal.port';
import { CommissionTransferService } from '../../treasury/application/commission-transfer.service';
import type { OutboxHandler } from '../application/outbox-handler';
import type {
  CommissionTransferPayload,
  PortalApplicationPaidPayload,
} from '../domain/messages';

@Injectable()
export class PortalApplicationPaidHandler implements OutboxHandler<'portal.application_paid'> {
  readonly type = 'portal.application_paid' as const;
  constructor(@Inject(PORTAL_CLIENT) private readonly portal: PortalClient) {}
  handle(p: PortalApplicationPaidPayload): Promise<void> {
    return this.portal.notifyPayment({ event: 'application_paid', currency: 'SLE', ...p });
  }
}

/** Internal transfer of the commission; idempotent on the payment id. */
@Injectable()
export class CommissionTransferHandler implements OutboxHandler<'monime.commission_transfer'> {
  readonly type = 'monime.commission_transfer' as const;
  constructor(private readonly transfers: CommissionTransferService) {}
  handle(p: CommissionTransferPayload): Promise<void> {
    return this.transfers.send(p);
  }
}
