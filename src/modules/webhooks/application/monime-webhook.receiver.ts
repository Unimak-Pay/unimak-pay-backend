import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { OutboxDispatcher } from '../../outbox/application/outbox-dispatcher';
import { type SettlementResult, SettlePaymentService } from '../../payments/application/settle-payment.service';
import { verifyMonimeSignature } from '../domain/monime-signature';
import { TreasuryEventsService } from '../../treasury/application/treasury-events.service';
import {
  eventTime,
  InvalidWebhookPayloadError,
  MONIME_EVENTS,
  type MonimeWebhookEnvelope,
  parseAccountMovement,
  parseCompletedPayment,
  parseInternalTransfer,
  parseMonimeWebhook,
  parsePayout,
} from '../domain/monime-webhook';
import { type InboxEvent, WebhookInbox } from '../infrastructure/webhook-inbox';

export class WebhookSignatureError extends Error {}

export type WebhookResult = SettlementResult['outcome'] | 'DUPLICATE';

export interface WebhookAck {
  received: true;
  eventId: string;
  result: WebhookResult;
  note?: string;
}

/**
 * Single entry point for Monime webhooks (the real route and the dev simulator):
 * verify signature → parse envelope → claim in inbox → dispatch → complete,
 * all in one transaction. Unexpected errors roll back, are recorded as FAILED
 * and propagate (5xx) so Monime redelivers.
 */
@Injectable()
export class MonimeWebhookReceiver {
  private readonly logger = new Logger(MonimeWebhookReceiver.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly inbox: WebhookInbox,
    private readonly settle: SettlePaymentService,
    private readonly treasury: TreasuryEventsService,
    private readonly dispatcher: OutboxDispatcher,
  ) {}

  async receive(rawBody: Buffer | undefined, signatureHeader: string | undefined): Promise<WebhookAck> {
    if (!rawBody) throw new WebhookSignatureError('Missing raw request body');
    const check = verifyMonimeSignature({
      rawBody,
      header: signatureHeader,
      secret: this.config.get('MONIME_WEBHOOK_SECRET'),
      toleranceSeconds: this.config.get('MONIME_WEBHOOK_TOLERANCE_SECONDS'),
    });
    if (!check.valid) {
      this.logger.warn(`Rejected Monime webhook: ${check.reason}`);
      throw new WebhookSignatureError(check.reason);
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new InvalidWebhookPayloadError('Body is not JSON');
    }
    const env = parseMonimeWebhook(body);
    return this.process(env, body);
  }

  private async process(env: MonimeWebhookEnvelope, payload: unknown): Promise<WebhookAck> {
    const stored: InboxEvent = { id: env.event.id, type: env.event.name, payload };
    let result: SettlementResult | 'DUPLICATE';
    try {
      result = await this.prisma.$transaction(
        async (tx) => {
          if (!(await this.inbox.claim(tx, stored))) return 'DUPLICATE' as const;
          const r = await this.dispatch(tx, env);
          await this.inbox.complete(tx, stored.id, r.outcome, r.note);
          return r;
        },
        { timeout: 15_000 },
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`${stored.type} ${stored.id} failed: ${message}`);
      await this.inbox.recordFailure(stored, message).catch((e: unknown) =>
        this.logger.error(`Could not record webhook failure: ${(e as Error).message}`),
      );
      throw err;
    }

    if (result === 'DUPLICATE') return { received: true, eventId: stored.id, result };
    if (result.outcome !== 'PROCESSED' || result.note) {
      this.logger.warn(`${stored.type} ${stored.id}: ${result.outcome} (${result.note ?? '-'})`);
    }
    if (result.outboxKeys.length && this.config.get('OUTBOX_DISPATCH_INLINE')) {
      await this.dispatcher.dispatchKeys(result.outboxKeys);
    }
    return { received: true, eventId: stored.id, result: result.outcome, ...(result.note ? { note: result.note } : {}) };
  }

  private dispatch(tx: Parameters<SettlePaymentService['applyCompleted']>[0], env: MonimeWebhookEnvelope): Promise<SettlementResult> {
    const at = eventTime(env, new Date());
    switch (env.event.name) {
      case MONIME_EVENTS.paymentCompleted:
        return this.settle.applyCompleted(tx, { ...parseCompletedPayment(env), occurredAt: at });
      case MONIME_EVENTS.transferCompleted:
        return this.treasury.applyTransfer(tx, parseInternalTransfer(env), 'completed', at);
      case MONIME_EVENTS.transferFailed:
        return this.treasury.applyTransfer(tx, parseInternalTransfer(env), 'failed', at);
      case MONIME_EVENTS.payoutCompleted:
        return this.treasury.applyPayout(tx, parsePayout(env), 'completed', at);
      case MONIME_EVENTS.payoutFailed:
        return this.treasury.applyPayout(tx, parsePayout(env), 'failed', at);
      case MONIME_EVENTS.accountCredited:
      case MONIME_EVENTS.accountDebited:
        return this.treasury.applyAccountMovement(tx, parseAccountMovement(env), at);
      default:
        return Promise.resolve({ outcome: 'IGNORED', note: `Unhandled event ${env.event.name}`, outboxKeys: [] });
    }
  }
}
