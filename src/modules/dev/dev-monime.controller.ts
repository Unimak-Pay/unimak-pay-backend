import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, Controller, HttpCode, Inject, NotFoundException, Post } from '@nestjs/common';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../shared/infrastructure/prisma.service';
import { MockMonimeClient } from '../integrations/monime/mock-monime.client';
import { MONIME_CLIENT, type MonimeClient } from '../integrations/monime/monime.port';
import { PAYMENT_REPOSITORY, type PaymentRepository } from '../payments/application/payment.repository';
import { ReconcilePaymentUseCase } from '../payments/application/reconcile-payment.use-case';
import { MonimeWebhookReceiver } from '../webhooks/application/monime-webhook.receiver';
import { signMonimePayload } from '../webhooks/domain/monime-signature';
import { MONIME_EVENTS } from '../webhooks/domain/monime-webhook';
import { SimulateWebhookDto } from './simulate-webhook.dto';

const MOCK_PAYOUT_FEE = 500; // SLE 5.00

/**
 * Dev-only (module not loaded when NODE_ENV=production).
 * POST /dev/monime/simulate-webhook — moves a mock Monime object to its final
 * state and delivers the matching signed webhook through the real receiver.
 */
@Controller('dev/monime')
export class DevMonimeController {
  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly receiver: MonimeWebhookReceiver,
    private readonly reconcile: ReconcilePaymentUseCase,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(MONIME_CLIENT) private readonly monime: MonimeClient,
  ) {}

  @Post('simulate-webhook')
  @HttpCode(200)
  async simulate(@Body() dto: SimulateWebhookDto) {
    const targets = [dto.paymentId, dto.transferId, dto.payoutId].filter(Boolean);
    if (targets.length !== 1) throw new BadRequestException('Give exactly one of paymentId, transferId, payoutId');
    if (dto.paymentId) return this.payment(dto.paymentId, dto);
    if (dto.transferId) return this.transfer(dto.transferId, dto);
    return this.payout(dto.payoutId!, dto);
  }

  private async payment(paymentId: string, dto: SimulateWebhookDto) {
    const p = await this.payments.byId(paymentId);
    if (!p) throw new NotFoundException('Payment not found');
    const o = (await this.payments.obligationInfo(p.obligationId))!;
    const mock = this.mock();

    if (dto.outcome === 'failed' || dto.outcome === 'expired') {
      if (!mock || !p.monimeRef) throw new BadRequestException('failed/expired needs MONIME_MODE=mock and a payment with a payment code');
      await mock.setStatus(p.monimeRef, dto.outcome === 'failed' ? 'cancelled' : 'expired');
      const after = await this.reconcile.execute(p.id);
      return { simulated: dto.outcome, paymentStatus: after.status, note: 'Payment code closed in the mock; our payment stays as it is (payments do not expire)' };
    }
    if (dto.outcome === 'processing') {
      const monimePaymentId = `pay-mock-${p.id.slice(0, 8)}`;
      return this.deliver(dto, MONIME_EVENTS.paymentProcessingStarted, { id: monimePaymentId, type: 'payment' }, {
        id: monimePaymentId,
        status: 'processing',
        amount: { currency: 'SLE', value: Number(dto.amount ?? p.amount) },
        channel: { type: 'momo', provider: 'm17', reference: 'mock' },
        reference: p.id,
        financialAccountId: o.settlementAccount,
        metadata: { paymentId: p.id, ...(dto.metadata ?? {}) },
        createTime: p.createdAt.toISOString(),
      });
    }

    const owner = p.monimeRef ?? p.checkoutSessionId;
    if (mock && owner) await mock.setStatus(owner, 'completed');
    const ownerType = p.collectionMethod === 'CHECKOUT_SESSION' ? 'checkout_session' : 'payment_code';
    const channelType = dto.channelType ?? 'momo';
    const monimePaymentId = `pay-mock-${p.id.slice(0, 8)}`;
    // Like Monime: the paying number comes masked, plus an order number.
    const payer = dto.payerPhone ?? p.payerPhone;
    const maskedPhone = payer && !payer.includes('*') ? `${payer.slice(0, 6)}****${payer.slice(-2)}` : payer;
    const orderNumber = `MO${p.paymentRef}`;
    await mock?.recordPayment({
      id: monimePaymentId, amount: BigInt(dto.amount ?? p.amount), financialAccountId: o.settlementAccount, reference: p.id,
      metadata: { paymentId: p.id }, ownerId: owner, fees: p.monimeFee, payerPhone: maskedPhone, orderNumber,
    });
    if (dto.deliver === false) return { simulated: 'completed', delivered: false, monimePaymentId, note: 'Recorded at Monime only (missed webhook)' };
    return this.deliver(dto, MONIME_EVENTS.paymentCompleted, { id: monimePaymentId, type: 'payment' }, {
      id: monimePaymentId,
      status: 'completed',
      amount: { currency: 'SLE', value: Number(dto.amount ?? p.amount) },
      channel: channelType === 'momo'
        ? { type: 'momo', provider: 'm17', reference: 'mock', phoneNumber: maskedPhone, fingerprint: 'mock' }
        : { type: channelType, reference: 'mock', fingerprint: 'mock' },
      orderNumber,
      reference: p.id,
      financialAccountId: o.settlementAccount,
      financialTransactionReference: `txn-mock-${p.id.slice(0, 8)}`,
      fees: p.monimeFee > 0n ? [{ code: 'processing', amount: { currency: 'SLE', value: Number(p.monimeFee) } }] : [],
      // the payment code's metadata, as we set it at initiation
      ownershipGraph: { owner: { id: owner, type: ownerType, metadata: { paymentId: p.id, paymentRef: p.paymentRef, ...(p.phoneAuthorized && p.payerPhone ? { payer_phone: p.payerPhone } : {}) } } },
      metadata: { paymentId: p.id, ...(dto.metadata ?? {}) },
      createTime: p.createdAt.toISOString(),
    });
  }

  private async transfer(transferId: string, dto: SimulateWebhookDto) {
    const t = await this.prisma.transfer.findUnique({ where: { id: transferId } });
    if (!t?.monimeTransferId) throw new NotFoundException('Transfer not found or not yet submitted to Monime');
    if (dto.outcome === 'expired') throw new BadRequestException('Transfers complete or fail');
    const failure = dto.outcome === 'failed' ? { code: 'fund_insufficient', message: 'Not enough funds in the source account' } : null;
    await this.mock()?.setStatus(t.monimeTransferId, dto.outcome, failure ? { failureDetail: failure } : {});
    return this.deliver(dto, dto.outcome === 'completed' ? MONIME_EVENTS.transferCompleted : MONIME_EVENTS.transferFailed,
      { id: t.monimeTransferId, type: 'internal_transfer' }, {
        id: t.monimeTransferId,
        status: dto.outcome,
        amount: { currency: 'SLE', value: Number(dto.amount ?? t.amount) },
        sourceFinancialAccount: { id: t.sourceAccount },
        destinationFinancialAccount: { id: t.destinationAccount },
        failureDetail: failure,
        metadata: { transferId: t.id, paymentId: t.paymentId ?? '' },
      });
  }

  private async payout(payoutId: string, dto: SimulateWebhookDto) {
    const p = await this.prisma.payout.findUnique({ where: { id: payoutId }, include: { financialAccount: true } });
    if (!p?.monimePayoutId) throw new NotFoundException('Payout not found or not yet submitted to Monime');
    if (dto.outcome === 'expired') throw new BadRequestException('Payouts complete or fail');
    const failure = dto.outcome === 'failed' ? { code: 'provider_account_missing', message: 'Destination account not found' } : null;
    await this.mock()?.setStatus(p.monimePayoutId, dto.outcome, failure ? { failureDetail: failure } : { fees: String(MOCK_PAYOUT_FEE) });
    return this.deliver(dto, dto.outcome === 'completed' ? MONIME_EVENTS.payoutCompleted : MONIME_EVENTS.payoutFailed,
      { id: p.monimePayoutId, type: 'payout' }, {
        id: p.monimePayoutId,
        status: dto.outcome,
        amount: { currency: 'SLE', value: Number(dto.amount ?? p.amount) },
        source: { financialAccountId: p.financialAccount.monimeId },
        destination: { type: p.destinationType, providerId: p.providerId, accountNumber: p.accountNumber },
        fees: dto.outcome === 'completed' ? [{ code: 'payout', amount: { currency: 'SLE', value: MOCK_PAYOUT_FEE } }] : [],
        failureDetail: failure,
        metadata: { payoutId: p.id },
      });
  }

  private async deliver(dto: SimulateWebhookDto, name: string, object: Record<string, unknown>, data: Record<string, unknown>) {
    const now = Math.floor(Date.now() / 1000);
    const envelope = {
      apiVersion: this.config.get('MONIME_API_VERSION'),
      event: { id: dto.eventId ?? `wke-mock-${randomUUID()}`, name, timestamp: String(now) },
      object,
      data: { ...data, updateTime: new Date(now * 1000).toISOString() },
    };
    const raw = Buffer.from(JSON.stringify(envelope));
    const signature = signMonimePayload(raw, this.config.get('MONIME_WEBHOOK_SECRET'), String(now));
    const ack = await this.receiver.receive(raw, signature);
    return { simulated: dto.outcome, ack, event: envelope, signature };
  }

  private mock(): MockMonimeClient | null {
    return this.monime instanceof MockMonimeClient ? this.monime : null;
  }
}
