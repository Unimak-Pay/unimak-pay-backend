import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import type { Minor } from '../../../shared/domain/money';
import type { Db } from '../../../shared/infrastructure/prisma.service';
import { APPLICATION_FEE_CODE } from '../../catalog/domain/fee';
import { LEDGER_REPOSITORY, type LedgerRepository } from '../../ledger/application/ledger.repository';
import { computePosition } from '../../ledger/domain/position';
import type { OutboxMessageInput } from '../../outbox/domain/messages';
import { OutboxWriter } from '../../outbox/application/outbox-writer';
import { ReceiptIssuer } from '../../receipts/application/receipt-issuer';
import { receiptSmsText } from '../../receipts/application/receipt-sms';
import { canTransition, isLateSettlement } from '../domain/payment-status';
import { PAYMENT_REPOSITORY, type PaymentRecord, type PaymentRepository } from './payment.repository';

/** Normalized outcome of a Monime payment event (adapter-independent). */
export interface PaymentOutcome {
  /** our payment id, if Monime echoes it back */
  reference: string | null;
  monimeRef: string | null;
  status: 'COMPLETED' | 'FAILED' | 'EXPIRED';
  /** amount Monime says it collected (minor units), when known */
  amount: Minor | null;
  occurredAt: Date;
  reason?: string;
}

export type SettlementResult =
  | { kind: 'settled'; paymentId: string; receiptNumber: string; outboxKeys: string[]; late: boolean }
  | { kind: 'closed'; paymentId: string; status: 'FAILED' | 'EXPIRED' }
  | { kind: 'noop'; paymentId: string | null; reason: string };

export class SettlementError extends Error {}

/**
 * Applies a payment outcome inside the caller's transaction:
 * COMPLETED → payment row, ledger PAYMENT (unique on paymentId), obligation
 * status, receipt, and outbox (sms.receipt, portal.application_paid for APP,
 * monime.commission_transfer when platformFee > 0).
 */
@Injectable()
export class SettlePaymentService {
  private readonly logger = new Logger(SettlePaymentService.name);

  constructor(
    private readonly config: AppConfig,
    private readonly receipts: ReceiptIssuer,
    private readonly outbox: OutboxWriter,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
  ) {}

  async apply(tx: Db, outcome: PaymentOutcome): Promise<SettlementResult> {
    const found = await this.find(tx, outcome);
    if (!found) return { kind: 'noop', paymentId: null, reason: 'unknown payment' };
    const p = (await this.payments.lockPayment(found.id, tx))!;

    if (p.status === outcome.status) return { kind: 'noop', paymentId: p.id, reason: 'already applied' };
    if (!canTransition(p.status, outcome.status)) {
      return { kind: 'noop', paymentId: p.id, reason: `ignored ${p.status} → ${outcome.status}` };
    }

    if (outcome.status !== 'COMPLETED') {
      await this.payments.update(p.id, { status: outcome.status, failureReason: outcome.reason ?? outcome.status.toLowerCase() }, tx);
      return { kind: 'closed', paymentId: p.id, status: outcome.status };
    }

    if (outcome.amount !== null && outcome.amount !== p.amount) {
      // Never guess with money: leave it for reconciliation.
      throw new SettlementError(`Amount mismatch for payment ${p.id}: ours ${p.amount}, Monime ${outcome.amount}`);
    }
    const late = isLateSettlement(p.status);
    if (late) this.logger.warn(`Late settlement: payment ${p.id} was ${p.status}, Monime says COMPLETED`);
    return this.complete(tx, p, outcome, late);
  }

  private async complete(tx: Db, p: PaymentRecord, outcome: PaymentOutcome, late: boolean): Promise<SettlementResult> {
    const completedAt = outcome.occurredAt;
    await this.payments.update(
      p.id,
      { status: 'COMPLETED', completedAt, monimeRef: p.monimeRef ?? outcome.monimeRef, failureReason: null },
      tx,
    );
    await this.ledger.append(
      { obligationId: p.obligationId, type: 'PAYMENT', amount: -p.amount, paymentId: p.id, memo: `monime ${outcome.monimeRef ?? ''}`.trim(), createdBy: 'system:monime-webhook' },
      tx,
    );

    const o = (await this.payments.obligationInfo(p.obligationId, tx))!;
    const l = (await this.ledger.ledgersFor([o.id], tx)).get(o.id)!;
    const position = computePosition(o.amount, l.entries, [], completedAt);
    if (position.balance <= 0n && o.status !== 'PAID') {
      await tx.obligation.update({ where: { id: o.id }, data: { status: 'PAID' } });
    }

    const receipt = await this.receipts.issue(tx, {
      paymentId: p.id, payerId: o.payerId, obligationId: o.id, amount: p.amount, issuedAt: completedAt,
    });

    const messages: OutboxMessageInput[] = [
      {
        type: 'sms.receipt',
        dedupeKey: `sms.receipt:${p.id}`,
        payload: {
          phone: p.payerPhone,
          receiptNumber: receipt.number,
          text: receiptSmsText({
            amount: p.amount, feeName: o.feeName, payerRef: o.payerRef, receiptNumber: receipt.number,
            balance: position.balance, verifyUrl: `${this.config.get('PUBLIC_BASE_URL')}/r/${receipt.verifyCode}`,
          }),
        },
      },
    ];
    if (o.feeTypeCode === APPLICATION_FEE_CODE) {
      messages.push({
        type: 'portal.application_paid',
        dedupeKey: `portal.application_paid:${p.id}`,
        payload: { applicationRef: o.payerRef, receiptNumber: receipt.number, amount: p.amount.toString(), paidAt: completedAt.toISOString() },
      });
    }
    if (p.platformFee > 0n) {
      messages.push({
        type: 'monime.commission_transfer',
        dedupeKey: `monime.commission_transfer:${p.id}`,
        payload: { paymentId: p.id, fromAccount: o.settlementAccount, toAccount: this.config.get('PLATFORM_MONIME_ACCOUNT'), amount: p.platformFee.toString() },
      });
    }
    const outboxKeys = await this.outbox.enqueue(tx, messages);
    return { kind: 'settled', paymentId: p.id, receiptNumber: receipt.number, outboxKeys, late };
  }

  private async find(tx: Db, o: PaymentOutcome): Promise<PaymentRecord | null> {
    if (o.monimeRef) {
      const byRef = await this.payments.byMonimeRef(o.monimeRef, tx);
      if (byRef) return byRef;
    }
    if (o.reference && /^[0-9a-f-]{36}$/i.test(o.reference)) return this.payments.byId(o.reference, tx);
    return null;
  }
}
