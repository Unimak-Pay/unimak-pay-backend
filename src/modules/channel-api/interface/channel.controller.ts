import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { PayerKind } from '../../catalog/domain/payer-profile';
import { LookupPayerUseCase } from '../../payers/application/lookup-payer.use-case';
import { PayerObligationsQuery } from '../../payers/application/payer-obligations.query';
import { InitiatePaymentUseCase } from '../../payments/application/initiate-payment.use-case';
import { PAYMENT_REPOSITORY, type PaymentRepository } from '../../payments/application/payment.repository';
import { QuotePaymentUseCase } from '../../payments/application/quote-payment.use-case';
import { ReceiptsQuery } from '../../receipts/application/receipts.query';
import { ResendReceiptUseCase } from '../../receipts/application/resend-receipt.use-case';
import { ChannelAuthGuard, type ChannelRequest } from './channel-auth.guard';
import { CreatePaymentDto, QuoteDto } from './dto';
import { PayerKindPipe, RefPipe } from './payer-kind.pipe';
import { presentObligation, presentPayer, presentPayment, presentReceipt } from './presenters';

@Controller('v1/channel')
@UseGuards(ChannelAuthGuard)
export class ChannelController {
  constructor(
    private readonly lookup: LookupPayerUseCase,
    private readonly obligations: PayerObligationsQuery,
    private readonly quote: QuotePaymentUseCase,
    private readonly initiate: InitiatePaymentUseCase,
    private readonly receipts: ReceiptsQuery,
    private readonly resend: ResendReceiptUseCase,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
  ) {}

  @Get('payers/:kind/:ref')
  async getPayer(@Param('kind', PayerKindPipe) kind: PayerKind, @Param('ref', RefPipe) ref: string) {
    const { payer, stale } = await this.lookup.execute(kind, ref);
    return presentPayer(payer, stale);
  }

  @Get('payers/:kind/:ref/obligations')
  async getObligations(@Param('kind', PayerKindPipe) kind: PayerKind, @Param('ref', RefPipe) ref: string) {
    const { payer, stale } = await this.lookup.execute(kind, ref);
    const views = await this.obligations.forPayer(payer);
    return { payer: presentPayer(payer, stale), obligations: views.map(presentObligation) };
  }

  @Post('quotes')
  @HttpCode(200)
  async postQuote(@Body() dto: QuoteDto) {
    const q = await this.quote.execute({ obligationId: dto.obligationId, amount: BigInt(dto.amount), channel: dto.channel });
    return {
      amount: dto.amount,
      payable: q.position.payable.toString(),
      minInstalment: q.minInstalment.toString(),
      payerPays: dto.amount, // never anything extra
      valid: true,
    };
  }

  @Post('payments')
  @HttpCode(201)
  async postPayment(@Req() req: ChannelRequest, @Body() dto: CreatePaymentDto) {
    const p = await this.initiate.execute({
      clientId: req.channelClient!.id,
      obligationId: dto.obligationId,
      amount: BigInt(dto.amount),
      payerPhone: dto.payerPhone,
      channel: dto.channel,
      idempotencyKey: dto.idempotencyKey,
    });
    const v = presentPayment(p);
    return { paymentId: v.paymentId, status: v.status, expiresAt: v.expiresAt };
  }

  @Get('payments/:id')
  async getPayment(@Req() req: ChannelRequest, @Param('id', ParseUUIDPipe) id: string) {
    const p = await this.payments.byId(id);
    if (!p || p.clientId !== req.channelClient!.id) throw new NotFoundException('Payment not found');
    return presentPayment(p);
  }

  @Get('payers/:kind/:ref/receipts')
  async getReceipts(@Param('kind', PayerKindPipe) kind: PayerKind, @Param('ref', RefPipe) ref: string) {
    const { payer } = await this.lookup.execute(kind, ref);
    return { receipts: (await this.receipts.forPayer(payer.id)).map(presentReceipt) };
  }

  @Post('receipts/:number/resend')
  @HttpCode(202)
  resendReceipt(@Param('number') number: string) {
    if (!/^UNIMAK-\d{4}-\d{6}$/.test(number)) throw new NotFoundException('Receipt not found');
    return this.resend.execute(number);
  }
}
