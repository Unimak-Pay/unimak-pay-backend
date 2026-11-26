import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainError } from '../../../shared/domain/errors';
import { MONIME_CLIENT, type MonimeClient } from '../../integrations/monime/monime.port';
import { isOpen } from '../domain/payment-status';
import { PAYMENT_REPOSITORY, type PaymentRecord, type PaymentRepository } from './payment.repository';

/**
 * "Check with Monime" for an open payment. Payments no longer expire
 * (docs/payment-lifecycle.md): an expired or cancelled payment code at Monime leaves
 * our payment PENDING (Monime handles USSD codes itself), so this only reports what
 * Monime says. Completion is never taken from polling; only the webhook (or the
 * nightly reconciliation of Monime's payments) marks COMPLETED.
 */
@Injectable()
export class ReconcilePaymentUseCase {
  private readonly logger = new Logger(ReconcilePaymentUseCase.name);

  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(MONIME_CLIENT) private readonly monime: MonimeClient,
  ) {}

  async execute(paymentId: string): Promise<PaymentRecord> {
    const p = await this.payments.byId(paymentId);
    if (!p) throw new DomainError('NOT_FOUND', 'Payment not found');
    if (!isOpen(p.status) || !p.monimeRef) return p;
    const code = await this.monime.getPaymentCode(p.monimeRef);
    if (code.status === 'expired' || code.status === 'cancelled') {
      this.logger.log(`Payment ${p.id}: Monime payment code is ${code.status}; payment stays ${p.status}`);
    }
    return p;
  }
}
