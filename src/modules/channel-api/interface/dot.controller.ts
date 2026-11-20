import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { DomainError } from '../../../shared/domain/errors';
import type { PayerKind } from '../../catalog/domain/payer-profile';
import { LookupPayerUseCase } from '../../payers/application/lookup-payer.use-case';
import { PayerObligationsQuery } from '../../payers/application/payer-obligations.query';
import { InitiatePaymentUseCase } from '../../payments/application/initiate-payment.use-case';
import { PAYMENT_REPOSITORY, type PaymentRepository } from '../../payments/application/payment.repository';
import { PaymentStatusQuery } from '../../payments/application/payment-status.query';
import { QuotePaymentUseCase } from '../../payments/application/quote-payment.use-case';
import { DotRateLimitGuard } from './dot-rate-limit.guard';
import { DotAmountDto, IDEMPOTENCY_KEY } from './dto';
import { PayerKindPipe, RefPipe } from './payer-kind.pipe';
import { presentDotOrder, presentObligation, presentPayer, presentPayment, presentPaymentStatus } from './presenters';

/** clientId recorded on payments started from the dot (idempotency scope). */
export const DOT_CLIENT_ID = 'dash-dot';

/**
 * Public API for the UNIMAK dot in Monime Dash. A dot's code is public, so there is
 * no secret: callers are limited per IP, payer details are masked, and everything
 * that matters (amounts, the receiving account) is decided here. Money only moves
 * in Dash's payment sheet, and only Monime's webhook marks a payment COMPLETED.
 */
@Controller('v1/dot')
@UseGuards(DotRateLimitGuard)
export class DotController {
  constructor(
    private readonly lookup: LookupPayerUseCase,
    private readonly obligations: PayerObligationsQuery,
    private readonly quote: QuotePaymentUseCase,
    private readonly initiate: InitiatePaymentUseCase,
    private readonly paymentStatus: PaymentStatusQuery,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
  ) {}

  @Get('payers/:kind/:ref')
  async getPayer(@Param('kind', PayerKindPipe) kind: PayerKind, @Param('ref', RefPipe) ref: string) {
    const { payer, stale } = await this.lookup.execute(kind, ref);
    const views = await this.obligations.forPayer(payer);
    return { payer: presentPayer(payer, stale), obligations: views.map(presentObligation) };
  }

  @Post('quotes')
  @HttpCode(200)
  async postQuote(@Body() dto: DotAmountDto) {
    const q = await this.quote.execute({ obligationId: dto.obligationId, amount: BigInt(dto.amount), channel: 'DOTS' });
    return { amount: dto.amount, payable: q.position.payable.toString(), minInstalment: q.minInstalment.toString(), valid: true };
  }

  /**
   * Holds the amount and returns the order for `dash.payments.request()`. Idempotent on
   * the `Idempotency-Key` header: a retry returns the same payment and order.
   */
  @Post('payments')
  @HttpCode(201)
  async postPayment(@Headers('idempotency-key') key: string | undefined, @Body() dto: DotAmountDto) {
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      throw new DomainError('VALIDATION', 'Idempotency-Key header must be 8-100 letters, digits or _.:-');
    }
    const p = await this.initiate.execute({
      clientId: DOT_CLIENT_ID,
      obligationId: dto.obligationId,
      amount: BigInt(dto.amount),
      payerPhone: null, // Monime reports the paying number in the webhook
      phoneAuthorized: false,
      channel: 'DOTS',
      collection: 'DASH_SHEET',
      idempotencyKey: key,
    });
    const o = (await this.payments.obligationInfo(p.obligationId))!;
    const v = presentPayment(p);
    return {
      paymentId: v.paymentId,
      paymentRef: v.paymentRef,
      status: v.status,
      amount: v.amount,
      expiresAt: v.expiresAt,
      order: presentDotOrder(p, o),
      financialAccountId: o.settlementAccount!,
    };
  }

  /** By our 8-digit payment ref or Monime's order number; payer details masked. */
  @Get('payments/status/:ref')
  async getPaymentStatus(@Param('ref') ref: string) {
    const v = await this.paymentStatus.byPublicRef(ref.slice(0, 40));
    if (!v) throw new DomainError('NOT_FOUND', 'Payment not found');
    return presentPaymentStatus(v);
  }
}
