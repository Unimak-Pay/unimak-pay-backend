import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, Controller, HttpCode, Inject, NotFoundException, Post } from '@nestjs/common';
import { AppConfig } from '../../config/app-config';
import { MockMonimeClient } from '../integrations/monime/mock-monime.client';
import { MONIME_CLIENT, type MonimeClient } from '../integrations/monime/monime.port';
import { PAYMENT_REPOSITORY, type PaymentRepository } from '../payments/application/payment.repository';
import { ReconcilePaymentUseCase } from '../payments/application/reconcile-payment.use-case';
import { MonimeWebhookReceiver } from '../webhooks/application/monime-webhook.receiver';
import { signMonimePayload } from '../webhooks/domain/monime-signature';
import { PAYMENT_COMPLETED_EVENT } from '../webhooks/domain/monime-webhook';
import { SimulateWebhookDto } from './simulate-webhook.dto';

/**
 * Dev-only (module not loaded when NODE_ENV=production).
 * POST /dev/monime/simulate-webhook { paymentId, outcome, amount?, eventId? }
 */
@Controller('dev/monime')
export class DevMonimeController {
  constructor(
    private readonly config: AppConfig,
    private readonly receiver: MonimeWebhookReceiver,
    private readonly reconcile: ReconcilePaymentUseCase,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(MONIME_CLIENT) private readonly monime: MonimeClient,
  ) {}

  @Post('simulate-webhook')
  @HttpCode(200)
  async simulate(@Body() dto: SimulateWebhookDto) {
    const p = await this.payments.byId(dto.paymentId);
    if (!p) throw new NotFoundException('Payment not found');
    const o = (await this.payments.obligationInfo(p.obligationId))!;
    const mock = this.monime instanceof MockMonimeClient ? this.monime : null;

    if (dto.outcome !== 'completed') {
      if (!mock || !p.monimeRef) throw new BadRequestException('failed/expired needs MONIME_MODE=mock and a PENDING payment');
      await mock.settleCollection(p.monimeRef, dto.outcome === 'failed' ? 'FAILED' : 'EXPIRED');
      const after = await this.reconcile.execute(p.id);
      return { simulated: dto.outcome, paymentStatus: after.status, note: 'Monime has no payment-failed webhook; closed via reconciliation' };
    }

    if (mock && p.monimeRef) await mock.settleCollection(p.monimeRef, 'COMPLETED');
    const now = new Date();
    const monimePaymentId = `spm-mock-${p.id.slice(0, 8)}`;
    const envelope = {
      apiVersion: this.config.get('MONIME_API_VERSION'),
      event: { id: dto.eventId ?? `evt-mock-${randomUUID()}`, name: PAYMENT_COMPLETED_EVENT, timestamp: now.toISOString() },
      object: { id: monimePaymentId, type: 'payment' },
      data: {
        id: monimePaymentId,
        status: 'completed',
        amount: { currency: 'SLE', value: Number(dto.amount ?? p.amount) },
        financialAccountId: o.settlementAccount,
        reference: p.id,
        metadata: { paymentId: p.id },
        fees: p.monimeFee > 0n ? [{ code: 'processing', amount: { currency: 'SLE', value: Number(p.monimeFee) } }] : [],
        ownershipGraph: { owner: { id: p.monimeRef, type: 'payment_code', metadata: { channel: p.channel } } },
        createTime: p.createdAt.toISOString(),
      },
    };
    const raw = Buffer.from(JSON.stringify(envelope));
    const signature = signMonimePayload(raw, this.config.get('MONIME_WEBHOOK_SECRET'), String(Math.floor(now.getTime() / 1000)));
    const ack = await this.receiver.receive(raw, signature);
    return { simulated: 'completed', ack, event: envelope, signature };
  }
}
