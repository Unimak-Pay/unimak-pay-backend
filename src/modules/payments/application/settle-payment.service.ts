import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Minor } from '../../../shared/domain/money';
import type { Db } from '../../../shared/infrastructure/prisma.service';
import { APPLICATION_FEE_CODE } from '../../catalog/domain/fee';
import { LEDGER_REPOSITORY, type LedgerRepository } from '../../ledger/application/ledger.repository';
import { computePosition } from '../../ledger/domain/position';
import { OutboxWriter } from '../../outbox/application/outbox-writer';
import type { OutboxMessageInput } from '../../outbox/domain/messages';
import { AuditService } from '../../audit/audit.service';
import { ReceiptIssuer } from '../../receipts/application/receipt-issuer';
import { auditDeleted } from './expire-payments.use-case';
import { resolvePayerPhone } from '../domain/payer-phone';
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
  /** channel number as Monime reports it (usually masked: +23276****56) */
  payerPhone?: string | null;
  /** Monime order number (in Monime's own SMS to the payer) */
  orderNumber?: string | null;
  /** channel.type: bank | card | momo | wallet */
  channelType?: string | null;
  occurredAt: Date;
}

import type { SettlementResult } from './settlement-result';
export type { SettlementOutcome, SettlementResult } from './settlement-result';

/**
 * Applies payment.processing_completed inside the caller's transaction.
 * Only this path marks a payment COMPLETED. In one transaction:
 *   payment → COMPLETED (+ the number that paid, Monime's order number), ledger
 *   PAYMENT (unique on paymentId), obligation PAID if cleared, receipt, outbox
 *   (portal.application_paid for APP, monime.commission_transfer when
 *   platformFee > 0). No SMS from us: Monime texts the payer on completion.
 * Business mismatches don't throw: they come back UNMATCHED with a note for
 * reconciliation (Monime gets 200 and stops redelivering).
 */
@Injectable()
export class SettlePaymentService {
  private readonly logger = new Logger(SettlePaymentService.name);

  constructor(
    private readonly receipts: ReceiptIssuer,
    private readonly outbox: OutboxWriter,
    private readonly audit: AuditService,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
  ) {}

  async applyCompleted(tx: Db, ev: CompletedMonimePayment): Promise<SettlementResult> {
    const found = await this.match(tx, ev);
    if (!found) return notFound(ev);
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
      {
        status: 'COMPLETED', completedAt, monimePaymentId: ev.monimePaymentId, failureReason: null,
        monimeOrderNumber: ev.orderNumber ?? null,
        monimeChannelType: ev.channelType ?? null,
        payerPhone: resolvePayerPhone({ metadata: ev.metadata, reported: ev.payerPhone, current: p.payerPhone }),
      },
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

    // the payer's other attempts at this fee that never got paid are dropped (owner decision)
    await auditDeleted(this.audit, await this.payments.deleteAwaitingPayment({ obligationId: o.id, exceptId: p.id }, tx), `another payment for this fee completed (${p.paymentRef})`, tx);

    const messages: OutboxMessageInput[] = [];
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

  /**
   * payment.processing_started: the payer is paying. PENDING (or a late FAILED/EXPIRED)
   * → PROCESSING, which holds the amount. Never moves a COMPLETED payment back.
   */
  async applyProcessingStarted(tx: Db, ev: CompletedMonimePayment): Promise<SettlementResult> {
    const found = await this.match(tx, ev);
    if (!found) return notFound(ev);
    const p = (await this.payments.lockPayment(found.id, tx))!;
    const base = { paymentId: p.id, outboxKeys: [] as string[] };
    if (p.status === 'PROCESSING') return { ...base, outcome: 'PROCESSED', note: 'Already processing' };
    if (p.status === 'COMPLETED') return { ...base, outcome: 'PROCESSED', note: 'Already completed; processing_started arrived late' };
    if (ev.currency !== 'SLE' || ev.amount !== p.amount) {
      return { ...base, outcome: 'UNMATCHED', note: `Monime is processing ${ev.currency} ${ev.amount}, payment is for SLE ${p.amount}` };
    }
    if (!canTransition(p.status, 'PROCESSING')) return { ...base, outcome: 'UNMATCHED', note: `Payment is ${p.status}` };
    await this.payments.update(p.id, {
      status: 'PROCESSING', processingAt: ev.occurredAt, failureReason: null,
      monimeChannelType: ev.channelType ?? p.monimeChannelType ?? null,
    }, tx);
    return { ...base, outcome: 'PROCESSED' };
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

/**
 * No payment matches. If Monime's metadata says it was ours (a payment deleted while
 * awaiting payment, then paid with an old code or ref), it needs a person: UNMATCHED,
 * so it shows in reconciliation. Otherwise it isn't a UNIMAK payment.
 */
function notFound(ev: CompletedMonimePayment): SettlementResult {
  const ours = ev.metadata['paymentRef'] ?? ev.metadata['obligationId'] ?? PAYMENT_ID_METADATA_KEYS.map((k) => ev.metadata[k]).find(Boolean);
  if (!ours) return { outcome: 'IGNORED', note: 'Not a UNIMAK payment', outboxKeys: [] };
  return {
    outcome: 'UNMATCHED',
    note: `UNIMAK payment ${ev.metadata['paymentRef'] ?? ev.reference ?? '?'} not found (deleted while awaiting payment?); Monime ${ev.monimePaymentId} for obligation ${ev.metadata['obligationId'] ?? '?'}: apply or refund by hand`,
    outboxKeys: [],
  };
}
