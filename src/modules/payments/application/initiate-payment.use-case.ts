import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppConfig } from '../../../config/app-config';
import { DomainError } from '../../../shared/domain/errors';
import type { Minor } from '../../../shared/domain/money';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import type { Channel } from '../../catalog/application/catalog.repository';
import { MONIME_CLIENT, type MonimeClient, MonimeError } from '../../integrations/monime/monime.port';
import { PaymentEvaluator } from './payment-evaluator';
import { type CollectionMethod, PAYMENT_REPOSITORY, type PaymentRecord, type PaymentRepository } from './payment.repository';

export interface InitiatePaymentInput {
  clientId: string;
  obligationId: string;
  amount: Minor;
  /** the number that will pay, when known (Dots: given; USSD: only if verified) */
  payerPhone: string | null;
  channel: Channel;
  idempotencyKey: string;
  /** restrict the payment code to payerPhone (default true) */
  phoneAuthorized?: boolean;
  /**
   * PAYMENT_CODE (default): we create a Monime payment code after commit.
   * USSD_FLOW: the USSD flow's collect_payment template collects in-session;
   * we only record the PENDING payment (the hold) and return.
   * DASH_SHEET: the dot asks Dash's payment sheet for it (reference = our payment
   * id); likewise we only record the PENDING payment.
   */
  collection?: CollectionMethod;
}

/**
 * 1. Idempotency: same (client, key) returns the same payment (and retries the
 *    Monime call if it never got through).
 * 2. In a transaction with the obligation row locked (FOR UPDATE): expire stale
 *    holds, check min instalment ≤ amount ≤ payable, compute the split, insert
 *    an INITIATED payment.
 * 3. After commit: ask Monime to start the collection → PENDING (or FAILED if
 *    Monime rejects it). If Monime is unreachable it stays INITIATED; the client
 *    can retry with the same idempotency key, and the hold lapses at expiry.
 */
@Injectable()
export class InitiatePaymentUseCase {
  private readonly logger = new Logger(InitiatePaymentUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly evaluator: PaymentEvaluator,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(MONIME_CLIENT) private readonly monime: MonimeClient,
  ) {}

  async execute(input: InitiatePaymentInput, now = new Date()): Promise<PaymentRecord> {
    const existing = await this.payments.byIdempotencyKey(input.clientId, input.idempotencyKey);
    if (existing) return this.replay(existing, input, now);

    let payment: PaymentRecord;
    try {
      payment = await this.prisma.$transaction(async (tx) => {
        const o = await this.payments.lockObligation(input.obligationId, tx);
        if (!o) throw new DomainError('NOT_FOUND', 'Obligation not found');
        if (!o.settlementAccount) {
          throw new DomainError('INVALID_STATE', `Fee type ${o.feeTypeCode} has no Monime financial account yet (run pnpm monime:provision)`);
        }
        await this.payments.expireDue(now, o.id, tx);
        const ev = await this.evaluator.evaluate(o, input.amount, input.channel, now, tx);
        return this.payments.create(
          {
            obligationId: o.id,
            amount: input.amount,
            channel: input.channel,
            clientId: input.clientId,
            idempotencyKey: input.idempotencyKey,
            payerPhone: input.payerPhone,
            phoneAuthorized: input.phoneAuthorized ?? true,
            collectionMethod: input.collection ?? 'PAYMENT_CODE',
            pricingConfigId: ev.pricingConfigId,
            monimeFee: ev.split.monimeFee,
            platformFee: ev.split.platformFee,
            netAmount: ev.split.netAmount,
            expiresAt: new Date(now.getTime() + this.config.get('PAYMENT_EXPIRY_MINUTES') * 60_000),
          },
          tx,
        );
      });
    } catch (err) {
      // Concurrent request with the same idempotency key won the insert.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.payments.byIdempotencyKey(input.clientId, input.idempotencyKey);
        if (winner) return this.replay(winner, input, now);
      }
      throw err;
    }
    if (payment.collectionMethod !== 'PAYMENT_CODE') return this.payments.update(payment.id, { status: 'PENDING' });
    return this.startCollection(payment);
  }

  private async replay(p: PaymentRecord, input: InitiatePaymentInput, now: Date): Promise<PaymentRecord> {
    if (
      p.obligationId !== input.obligationId || p.amount !== input.amount || p.channel !== input.channel ||
      p.collectionMethod !== (input.collection ?? 'PAYMENT_CODE')
    ) {
      throw new DomainError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used for a different payment');
    }
    if (p.collectionMethod !== 'PAYMENT_CODE') return p;
    if (p.status === 'INITIATED' && !p.monimeRef && p.expiresAt > now) return this.startCollection(p);
    return p;
  }

  private async startCollection(p: PaymentRecord): Promise<PaymentRecord> {
    const o = (await this.payments.obligationInfo(p.obligationId))!;
    try {
      const minutesLeft = Math.max(1, Math.ceil((p.expiresAt.getTime() - Date.now()) / 60_000));
      const code = await this.monime.createPaymentCode({
        idempotencyKey: p.id,
        name: `UNIMAK ${o.feeName}`,
        amount: p.amount,
        durationMinutes: minutesLeft,
        reference: p.id,
        authorizedPhoneNumber: p.phoneAuthorized && p.payerPhone ? p.payerPhone : undefined,
        financialAccountId: o.settlementAccount!,
        metadata: {
          paymentId: p.id, paymentRef: p.paymentRef, obligationId: o.id, payerRef: o.payerRef, feeTypeCode: o.feeTypeCode, channel: p.channel,
          // Monime masks the paying number in the webhook; an authorised code can only
          // be paid from this number, so it comes back whole in metadata.
          ...(p.phoneAuthorized && p.payerPhone ? { payer_phone: p.payerPhone } : {}),
        },
      });
      return await this.transitionAfterInitiate(p.id, { status: 'PENDING', monimeRef: code.id, ussdCode: code.ussdCode ?? undefined });
    } catch (err) {
      if (err instanceof MonimeError && err.code === 'REJECTED') {
        this.logger.warn(`Monime rejected payment ${p.id}: ${err.message}`);
        return this.transitionAfterInitiate(p.id, { status: 'FAILED', failureReason: `monime_rejected: ${err.message}` });
      }
      this.logger.error(`Monime initiate failed for payment ${p.id}: ${(err as Error).message}`);
      throw new DomainError('UPSTREAM_UNAVAILABLE', 'Payment provider unavailable, retry with the same idempotencyKey', {
        paymentId: p.id,
      });
    }
  }

  /** Only moves INITIATED → PENDING/FAILED; a webhook may already have finished it. */
  private async transitionAfterInitiate(
    id: string,
    patch: { status: 'PENDING' | 'FAILED'; monimeRef?: string; ussdCode?: string; failureReason?: string },
  ): Promise<PaymentRecord> {
    return this.prisma.$transaction(async (tx) => {
      const cur = (await this.payments.lockPayment(id, tx))!;
      if (cur.status !== 'INITIATED') {
        return patch.monimeRef && !cur.monimeRef
          ? this.payments.update(id, { monimeRef: patch.monimeRef, ussdCode: patch.ussdCode ?? null }, tx)
          : cur;
      }
      return this.payments.update(id, patch, tx);
    });
  }
}
