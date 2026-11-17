import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../../shared/domain/errors';
import type { Minor } from '../../../shared/domain/money';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import type { Channel } from '../../catalog/application/catalog.repository';
import { type Evaluation, PaymentEvaluator } from './payment-evaluator';
import { PAYMENT_REPOSITORY, type PaymentRepository } from './payment.repository';

/** Validates an amount and shows the fee split without creating anything. */
@Injectable()
export class QuotePaymentUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly evaluator: PaymentEvaluator,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
  ) {}

  async execute(input: { obligationId: string; amount: Minor; channel: Channel }, now = new Date()): Promise<Evaluation> {
    const o = await this.payments.obligationInfo(input.obligationId);
    if (!o) throw new DomainError('NOT_FOUND', 'Obligation not found');
    return this.evaluator.evaluate(o, input.amount, input.channel, now, this.prisma);
  }
}
