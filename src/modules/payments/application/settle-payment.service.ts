import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import type { Minor } from '../../../shared/domain/money';
import type { Db } from '../../../shared/infrastructure/prisma.service';
import { APPLICATION_FEE_CODE } from '../../catalog/domain/fee';
import { LEDGER_REPOSITORY, type LedgerRepository } from '../../ledger/application/ledger.repository';
import { computePosition } from '../../ledger/domain/position';
import { OutboxWriter } from '../../outbox/application/outbox-writer';
import type { OutboxMessageInput } from '../../outbox/domain/messages';
import { ReceiptIssuer } from '../../receipts/application/receipt-issuer';
import { receiptSmsText } from '../../receipts/application/receipt-sms';
import { canTransition, isLateSettlement } from '../domain/payment-status';
import { PAYMENT_REPOSITORY, type PaymentRecord, type PaymentRepository } from './payment.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Where our payment id may come back in a Monime Payment. */
const PAYMENT_ID_METADATA_KEYS = ['paymentId', 'payment_id', 'unimakPaymentId'];

/** A completed Monime Payment, already parsed from the webhook. */
export interface CompletedMonimePayment {
  monimePaymentId: string;
  financialAccountId: string | null;
  currency: string;
  amount: Minor;
  /** sum of Monime fees on the payment (informational) */
  fees: Minor;
  reference: string | null;
  /** payment metadata merged over its owner's (e.g. payment code / checkout) */
  metadata: Record<string, string>;
  /** the object that owns the payment — normally what we created at initiation */
  ownerId: string | null;
  /** number that actually paid (from the payment channel), if known */
  payerPhone?: string | null;
  occurredAt: Date;
}

import type { SettlementResult } from './settlement-result';
export type { SettlementOutcome, SettlementResult } from './settlement-result';

/**
 * Applies payment.processing_completed inside the caller's transaction.
 * Only this path marks a payment COMPLETED. In one transaction:
 *   payment → COMPLETED, ledger PAYMENT (unique on paymentId), obligation PAID if
 *   cleared, receipt, outbox (sms.receipt, portal.application_paid for APP,
 *   monime.commission_transfer when platformFee > 0).
 * Business mismatches don't throw: they come back UNMATCHED with a note for
 * reconciliation (Monime gets 200 and stops redelivering).
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

  async applyCompleted(tx: Db, ev: CompletedMonimePayment): Promise<SettlementResult> {
    const found = await this.match(tx, ev);
    if (!found) return { outcome: 'IGNORED', note: 'Not a UNIMAK payment', outboxKeys: [] };
    const p = (await this.payments.lockPayment(found.id, tx))!;
    const base = { paymentId: p.id, outboxKeys: [] as string[] };

    if (p.status === 'COMPLETED') {
      if (!p.monimePaymentId || p.monimePaymentId === ev.monimePaymentId) {
        return { ...base, outcome: 'PROCESSED', note: 'Payment already applied' };
      }
      return {
        ...base,
        outcome: 'UNMATCHED',
        note: `Second Monime payment ${ev.monimePaymentId} for a payment already settled by ${p.monimePaymentId} (possible double charge)`,
      };
    }
    if (ev.currency !== 'SLE') {
      return { ...base, outcome: 'UNMATCHED', note: `Payment in ${ev.currency}, expected SLE` };
    }
    if (ev.amount !== p.amount) {
      return { ...base, outcome: 'UNMATCHED', note: `Monime collected ${ev.amount}, payment was for ${p.amount}` };
    }
    if (!canTransition(p.status, 'COMPLETED')) {
      return { ...base, outcome: 'UNMATCHED', note: `Payment is ${p.status}` };
    }

    const notes: string[] = [];
    if (isLateSettlement(p.status)) {
      notes.push(`Late settlement: payment was ${p.status}`);
      this.logger.warn(`Late settlement of payment ${p.id} (was ${p.status})`);
    }
    if (ev.fees !== p.monimeFee) notes.push(`Monime fees ${ev.fees}, we computed ${p.monimeFee}`);

    const settled = await this.complete(tx, p, ev);
    if (settled.overpaidBy > 0n) notes.push(`Overpaid by ${settled.overpaidBy} (obligation balance below zero)`);
    if (ev.financialAccountId && ev.financialAccountId !== settled.settlementAccount) {
      notes.push(`Credited to ${ev.financialAccountId}, expected ${settled.settlementAccount}`);
    }
    return {
      outcome: 'PROCESSED',
      note: notes.length ? notes.join('; ') : undefined,
      paymentId: p.id,
      receiptNumber: settled.receiptNumber,
      outboxKeys: settled.outboxKeys,
    };
  }

  private async complete(
    tx: Db,
    p: PaymentRecord,
    ev: CompletedMonimePayment,
  ): Promise<{ receiptNumber: string; outboxKeys: string[]; settlementAccount: string | null; overpaidBy: bigint }> {
    const completedAt = ev.occurredAt;
    await this.payments.update(
      p.id,
      { status: 'COMPLETED', completedAt, monimePaymentId: ev.monimePaymentId, failureReason: null },
      tx,
    );
    await this.ledger.append(
      { obligationId: p.obligationId, type: 'PAYMENT', amount: -p.amount, paymentId: p.id, memo: `monime ${ev.monimePaymentId}`, createdBy: 'system:monime-webhook' },
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
    // Spec: the receipt goes to the paying phone and to the phone on the portal record.
    const first = messages[0]!;
    const extra: [string, string | null | undefined][] = [['channel', ev.payerPhone], ['portal', o.payerPortalPhone]];
    const sent = new Set([p.payerPhone]);
    for (const [tag, phone] of extra) {
      if (!phone || sent.has(phone)) continue;
      sent.add(phone);
      messages.push({ ...first, dedupeKey: `sms.receipt:${p.id}:${tag}`, payload: { ...first.payload, phone } } as OutboxMessageInput);
    }
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
        // destination (platform account) is resolved when the transfer is sent
        payload: { paymentId: p.id, fromAccount: o.settlementAccount!, amount: p.platformFee.toString() },
      });
    }
    const outboxKeys = await this.outbox.enqueue(tx, messages);
    return { receiptNumber: receipt.number, outboxKeys, settlementAccount: o.settlementAccount, overpaidBy: position.balance < 0n ? -position.balance : 0n };
  }

  /** Our payment id (reference / metadata) first, then the Monime object ids. */
  private async match(tx: Db, ev: CompletedMonimePayment): Promise<PaymentRecord | null> {
    const ids = new Set(
      [...PAYMENT_ID_METADATA_KEYS.map((k) => ev.metadata[k]), ev.reference].filter(
        (v): v is string => typeof v === 'string' && UUID.test(v),
      ),
    );
    for (const id of ids) {
      const p = await this.payments.byId(id, tx);
      if (p) return p;
    }
    for (const ref of [ev.ownerId, ev.monimePaymentId]) {
      if (!ref) continue;
      const p = await this.payments.byMonimeRef(ref, tx);
      if (p) return p;
    }
    return this.payments.byMonimePaymentId(ev.monimePaymentId, tx);
  }
}
