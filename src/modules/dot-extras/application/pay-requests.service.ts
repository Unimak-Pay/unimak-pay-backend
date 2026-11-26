import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppConfig } from '../../../config/app-config';
import { DomainError } from '../../../shared/domain/errors';
import { formatSle } from '../../../shared/domain/money';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { PayerObligationsQuery } from '../../payers/application/payer-obligations.query';
import { type Payer, programLine } from '../../payers/domain/payer';
import {
  cleanText, firstName, isPayable, isPayRequestCode, MAX_OPEN_PAY_REQUESTS, MESSAGE_MAX, newPayRequestCode, payRequestExpiry,
  payRequestShareUrl, payRequestStatus, RECIPIENT_MAX,
} from '../domain/pay-request';

export interface CreatePayRequestInput {
  obligationId: string;
  /** minor units; null = "whatever you can" */
  amount: bigint | null;
  message: string;
  recipientName: string | null;
  idempotencyKey: string;
}

const include = {
  payer: true,
  obligation: { include: { fee: true } },
  payments: { where: { status: 'COMPLETED' as const }, orderBy: { completedAt: 'asc' as const } },
} satisfies Prisma.PayRequestInclude;
type Row = Prisma.PayRequestGetPayload<{ include: typeof include }>;

const money = (v: bigint) => ({ value: v.toString(), display: formatSle(v) });

/**
 * Pay requests (docs/dot-extras.md §3). Contributions, `paid` and `status` come only
 * from the request's COMPLETED payments, which only Monime's confirmation sets.
 */
@Injectable()
export class PayRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly obligations: PayerObligationsQuery,
  ) {}

  async create(payer: Payer, input: CreatePayRequestInput, now = new Date()) {
    const message = cleanText(input.message);
    const recipientName = cleanText(input.recipientName);
    if (!message || message.length > MESSAGE_MAX) throw new DomainError('VALIDATION', `message must be 1-${MESSAGE_MAX} characters`);
    if (recipientName && recipientName.length > RECIPIENT_MAX) throw new DomainError('VALIDATION', `recipientName must be at most ${RECIPIENT_MAX} characters`);
    const requestHash = createHash('sha256')
      .update(JSON.stringify([payer.id, input.obligationId, input.amount?.toString() ?? null, message, recipientName]))
      .digest('hex');

    const existing = await this.prisma.payRequest.findUnique({ where: { payerId_idempotencyKey: { payerId: payer.id, idempotencyKey: input.idempotencyKey } }, include });
    if (existing) return this.replay(existing, requestHash, now);

    const view = (await this.obligations.forPayer(payer, now)).find((v) => v.obligation.id === input.obligationId);
    if (!view) throw new DomainError('NOT_FOUND', 'That fee was not found for this ID');
    if (view.obligation.status === 'PAID' || view.balance <= 0n) throw new DomainError('OBLIGATION_SETTLED', 'This fee is already paid');
    if (input.amount !== null && input.amount > view.payable) {
      throw new DomainError('AMOUNT_EXCEEDS_PAYABLE', `You can ask for at most ${formatSle(view.payable)}`, { payable: view.payable.toString() });
    }
    const mine = await this.prisma.payRequest.findMany({ where: { payerId: payer.id, cancelledAt: null, expiresAt: { gt: now } }, include });
    if (mine.filter((r) => isPayable(this.status(r, now))).length >= MAX_OPEN_PAY_REQUESTS) {
      throw new DomainError('VALIDATION', `You already have ${MAX_OPEN_PAY_REQUESTS} open requests. Wait for some to be paid or to expire.`);
    }

    const data = {
      payerId: payer.id, obligationId: input.obligationId, amount: input.amount, message, recipientName,
      idempotencyKey: input.idempotencyKey, requestHash, createdAt: now, expiresAt: payRequestExpiry(now, view.obligation.dueDate),
    };
    for (let attempt = 0; ; attempt++) {
      try {
        return this.present(await this.prisma.payRequest.create({ data: { ...data, code: newPayRequestCode() }, include }), now);
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
        const target = String((err.meta as { target?: unknown } | undefined)?.target ?? '');
        if (target.includes('idempotencyKey')) {
          const winner = await this.prisma.payRequest.findUnique({ where: { payerId_idempotencyKey: { payerId: payer.id, idempotencyKey: input.idempotencyKey } }, include });
          if (winner) return this.replay(winner, requestHash, now);
        }
        if (attempt >= 4) throw err; // code collision: 31^7 ≈ 2.7e10, try another
      }
    }
  }

  /** The sponsor's page: no alias check (the code is the secret); records the first open. */
  async byCode(code: string, now = new Date()) {
    if (!isPayRequestCode(code.toUpperCase())) throw new DomainError('NOT_FOUND', 'This request link is not valid');
    const c = code.toUpperCase();
    await this.prisma.payRequest.updateMany({ where: { code: c, openedAt: null }, data: { openedAt: now } });
    const row = await this.prisma.payRequest.findUnique({ where: { code: c }, include });
    if (!row) throw new DomainError('NOT_FOUND', 'This request link is not valid');
    return this.present(row, now);
  }

  async listFor(payer: Payer, now = new Date()) {
    const rows = await this.prisma.payRequest.findMany({ where: { payerId: payer.id }, include, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
    return { requests: rows.map((r) => this.present(r, now)) };
  }

  /**
   * For POST /v1/dot/payments with payRequestCode: the request must exist, be for this
   * obligation and still be payable. Returns its id, stored on the payment.
   */
  async forPayment(code: string, obligationId: string, now = new Date(), opts: { replay?: boolean } = {}): Promise<string> {
    const c = code.toUpperCase();
    const row = isPayRequestCode(c) ? await this.prisma.payRequest.findUnique({ where: { code: c }, include }) : null;
    if (!row) throw new DomainError('NOT_FOUND', 'This request link is not valid');
    if (row.obligationId !== obligationId) throw new DomainError('VALIDATION', 'This request is for a different fee');
    const status = this.status(row, now);
    // a retry of a payment already started through it may land after the request closed
    if (!opts.replay && !isPayable(status)) {
      throw new DomainError('INVALID_STATE', status === 'PAID' ? 'This request has already been paid' : 'This request is closed', { status });
    }
    return row.id;
  }

  async codeOf(id: string): Promise<string | null> {
    return (await this.prisma.payRequest.findUnique({ where: { id }, select: { code: true } }))?.code ?? null;
  }

  private replay(row: Row, requestHash: string, now: Date) {
    if (row.requestHash !== requestHash) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was used for a different request');
    return this.present(row, now);
  }

  private status(r: Row, now: Date) {
    return payRequestStatus({
      cancelledAt: r.cancelledAt, expiresAt: r.expiresAt, amount: r.amount,
      paid: r.payments.reduce((s, p) => s + p.amount, 0n), obligationPaid: r.obligation.status === 'PAID',
    }, now);
  }

  private present(r: Row, now: Date) {
    const kind = r.payer.kind === 'STUDENT' ? 'student' as const : 'applicant' as const;
    const paid = r.payments.reduce((s, p) => s + p.amount, 0n);
    return {
      code: r.code,
      shareUrl: payRequestShareUrl(this.config.get('DOT_LINK'), { code: r.code, kind, ref: r.payer.ref, obligationId: r.obligationId, amount: r.amount }),
      obligationId: r.obligationId,
      feeName: r.obligation.fee.name,
      amount: r.amount === null ? null : money(r.amount),
      paid: money(paid),
      status: this.status(r, now),
      message: r.message,
      requester: { kind, ref: r.payer.ref, firstName: firstName(r.payer.fullName), programLine: programLine(r.payer) },
      recipientName: r.recipientName,
      contributions: r.payments.map((p) => ({ paymentRef: p.paymentRef, name: p.paidByName, amount: money(p.amount), paidAt: (p.completedAt ?? p.updatedAt).toISOString() })),
      openedAt: r.openedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
    };
  }
}
