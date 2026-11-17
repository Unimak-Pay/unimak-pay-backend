import { Inject, Injectable } from '@nestjs/common';
import { PAYMENT_REPOSITORY, type PaymentRepository } from './payment.repository';

@Injectable()
export class ExpirePaymentsUseCase {
  constructor(@Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository) {}

  execute(now = new Date()): Promise<number> {
    return this.payments.expireDue(now);
  }
}
