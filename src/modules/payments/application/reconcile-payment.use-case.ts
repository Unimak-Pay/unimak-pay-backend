import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainError } from '../../../shared/domain/errors';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { MONIME_CLIENT, type MonimeClient } from '../../integrations/monime/monime.port';
import { isOpen } from '../domain/payment-status';
import { PAYMENT_REPOSITORY, type PaymentRecord, type PaymentRepository } from './payment.repository';

/**
 * We don't subscribe to payment_code.expired/cancelled, so an open payment
 * whose Monime payment code expired or was cancelled is closed by polling. Completion is never taken
 * from polling — only the webhook marks COMPLETED.
 */
@Injectable()
export class ReconcilePaymentUseCase {
  private readonly logger = new Logger(ReconcilePaymentUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(MONIME_CLIENT) private readonly monime: MonimeClient,
  ) {}

  async execute(paymentId: string): Promise<PaymentRecord> {
    const p = await this.payments.byId(paymentId);
    if (!p) throw new DomainError('NOT_FOUND', 'Payment not found');
    if (!isOpen(p.status) || !p.monimeRef) return p;

    const code = await this.monime.getPaymentCode(p.monimeRef);
    const closed = code.status === 'expired' ? 'EXPIRED' : code.status === 'cancelled' ? 'FAILED' : null;
    if (!closed) return p;
    const remote = { status: closed } as const;

    return this.prisma.$transaction(async (tx) => {
      const cur = (await this.payments.lockPayment(p.id, tx))!;
      if (!isOpen(cur.status)) return cur;
      this.logger.log(`Payment ${p.id} closed as ${remote.status} by reconciliation`);
      return this.payments.update(p.id, { status: remote.status, failureReason: `monime_${remote.status.toLowerCase()}` }, tx);
    });
  }
}
