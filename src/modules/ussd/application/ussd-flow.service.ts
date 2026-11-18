import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AppConfig } from '../../../config/app-config';
import { DomainError } from '../../../shared/domain/errors';
import { maskName } from '../../../shared/domain/mask';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { LookupPayerUseCase } from '../../payers/application/lookup-payer.use-case';
import { PayerObligationsQuery } from '../../payers/application/payer-obligations.query';
import { type Payer, programLine } from '../../payers/domain/payer';
import { InitiatePaymentUseCase } from '../../payments/application/initiate-payment.use-case';
import { PaymentStatusQuery, type PaymentStatusView } from '../../payments/application/payment-status.query';
import { ussdSubscriberIdFor } from '../../../shared/domain/phone';
import {
  type ExchangeReply, type ExchangeRequest, type Intent, MAX_AMOUNT_RETRIES, MAX_ID_RETRIES, PAGES, type PageId,
  parseSleInput, type SessionState, sleShort, toMajorAmount,
} from '../domain/flow';

export const USSD_CLIENT_ID = 'ussd-flow';
const EXPIRED = 'Session expired. Please dial again.';
const stop = (message: string): ExchangeReply => ({ action: 'stop', message });
const go = (pageId: PageId, pageData: Record<string, unknown> = {}): ExchangeReply => ({ action: 'navigate', pageId, pageData });

/**
 * The spec's USSD menu as a state machine over the flow's pages:
 *   home → id_type → enter_student_id | enter_application_ref → confirm_payer
 *        → select_fee → [enter_amount] → confirm_payment → make_payment (collect_payment)
 * plus Check balance, Check payment status (our ref or Monime's order number),
 * Help; try_again for wrong IDs/amounts. No SMS from us: Monime texts the payer.
 * flowData is untrusted: a page is only accepted when the server-side session
 * expects it, and every value is re-validated against our records.
 */
@Injectable()
export class UssdFlowService {
  private readonly logger = new Logger(UssdFlowService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly lookup: LookupPayerUseCase,
    private readonly obligations: PayerObligationsQuery,
    private readonly initiate: InitiatePaymentUseCase,
    private readonly paymentStatus: PaymentStatusQuery,
  ) {}

  async handle(req: ExchangeRequest): Promise<ExchangeReply> {
    const { sessionId, subscriberId } = req.global;
    const input = (req.flowData[req.currentPage] ?? '').trim();
    if (req.currentPage === PAGES.home) return this.home(sessionId, subscriberId, input);

    const session = await this.prisma.ussdSession.findUnique({ where: { id: sessionId } });
    if (!session || session.subscriberId !== subscriberId) return stop(EXPIRED);
    const state = session.state as unknown as SessionState;
    if (req.currentPage !== state.expect) {
      this.logger.warn(`USSD session ${sessionId}: got page ${req.currentPage}, expected ${state.expect}`);
      return stop(EXPIRED);
    }

    try {
      switch (state.expect) {
        case PAGES.idType: return await this.idType(sessionId, state, input);
        case PAGES.enterStudentId:
        case PAGES.enterApplicationRef: return await this.enterId(sessionId, subscriberId, state, input);
        case PAGES.enterPaymentRef: return await this.enterPaymentRef(sessionId, subscriberId, state, input);
        case PAGES.tryAgain: return await this.tryAgain(sessionId, state, input);
        case PAGES.confirmPayer: return await this.confirmPayer(sessionId, state, input);
        case PAGES.selectFee: return await this.selectFee(sessionId, state, input);
        case PAGES.enterAmount: return await this.enterAmount(sessionId, state, input);
        case PAGES.confirmPayment: return await this.confirmPayment(sessionId, subscriberId, state, input);
        default: return stop(EXPIRED);
      }
    } catch (err) {
      if (err instanceof DomainError) return stop(friendly(err));
      throw err;
    }
  }

  // ── pages ──────────────────────────────────────────────────────────────────

  /** First exchange of a session (the home menu is static in the flow). */
  private async home(sessionId: string, subscriberId: string, input: string): Promise<ExchangeReply> {
    if (input === 'help') return stop(this.config.get('USSD_HELP_MESSAGE'));
    if (input !== 'pay' && input !== 'balance' && input !== 'status') return stop('Invalid option.');
    const first = input === 'status' ? PAGES.enterPaymentRef : PAGES.idType;
    const state: SessionState = { expect: first, intent: input as Intent, idAttempts: 0, amountAttempts: 0 };
    const existing = await this.prisma.ussdSession.findUnique({ where: { id: sessionId } });
    if (existing && existing.subscriberId !== subscriberId) return stop(EXPIRED);
    await this.prisma.ussdSession.upsert({
      where: { id: sessionId },
      create: { id: sessionId, subscriberId, state: json(state) },
      update: { state: json(state) },
    });
    return go(first);
  }

  private async idType(id: string, state: SessionState, input: string): Promise<ExchangeReply> {
    if (input !== 'student' && input !== 'applicant') return stop('Invalid option.');
    const kind = input === 'student' ? 'STUDENT' : 'APPLICANT';
    const page = kind === 'STUDENT' ? PAGES.enterStudentId : PAGES.enterApplicationRef;
    await this.save(id, { ...state, kind, expect: page });
    return go(page);
  }

  private async enterId(id: string, subscriberId: string, state: SessionState, input: string): Promise<ExchangeReply> {
    // Stop people enumerating student IDs from one phone.
    if ((await this.lookupsInWindow(subscriberId)) >= this.config.get('USSD_MAX_LOOKUPS_PER_15_MIN')) {
      return stop('Too many lookups. Please try again later.');
    }
    await this.prisma.ussdSession.update({ where: { id }, data: { lookups: { increment: 1 } } });

    // Student IDs and application refs may contain letters (e.g. UNI-2025-0002).
    const ref = input.toUpperCase().replace(/\s+/g, '');
    let payer: Payer | null = null;
    if (/^[A-Z0-9/-]{3,32}$/.test(ref)) {
      try {
        payer = (await this.lookup.execute(state.kind!, ref)).payer;
      } catch (err) {
        if (!(err instanceof DomainError) || err.code !== 'PAYER_NOT_FOUND') throw err;
      }
    }
    if (!payer) {
      const attempts = state.idAttempts + 1;
      const what = state.kind === 'STUDENT' ? 'Student ID' : 'Application No.';
      if (attempts > MAX_ID_RETRIES) return stop(`${what} not found. Please check it and try again later.`);
      return this.offerRetry(id, { ...state, idAttempts: attempts }, `${what} ${ref || '(empty)'} not found.`, state.expect as PageId, {});
    }

    const next: SessionState = { ...state, ref: payer.ref };
    if (state.intent === 'balance') return this.finish(id, next, await this.balanceText(payer));
    await this.save(id, { ...next, expect: PAGES.confirmPayer });
    return go(PAGES.confirmPayer, { payer_name: maskName(payer.fullName), program_line: programLine(payer) });
  }

  private async tryAgain(id: string, state: SessionState, input: string): Promise<ExchangeReply> {
    if (input !== 'retry' || !state.retry) return this.finish(id, state, 'Cancelled.');
    await this.save(id, { ...state, expect: state.retry.pageId, retry: undefined });
    return go(state.retry.pageId, state.retry.pageData);
  }

  private async confirmPayer(id: string, state: SessionState, input: string): Promise<ExchangeReply> {
    if (input !== 'continue') return this.finish(id, state, 'Cancelled.');
    const payer = await this.payer(state);
    const open = (await this.obligations.forPayer(payer)).filter((v) => v.payable > 0n).slice(0, 8);
    if (open.length === 0) return this.finish(id, state, `${maskName(payer.fullName)}: nothing to pay right now. All clear!`);
    const options = Object.fromEntries(open.map((v, i) => [String(i + 1), v.obligation.id]));
    await this.save(id, { ...state, feeOptions: options, expect: PAGES.selectFee });
    return go(PAGES.selectFee, {
      fees: open.map((v, i) => ({ value: String(i + 1), label: `${v.obligation.feeName} bal ${sleShort(v.payable)}` })),
    });
  }

  private async selectFee(id: string, state: SessionState, input: string): Promise<ExchangeReply> {
    const obligationId = state.feeOptions?.[input];
    if (!obligationId) return this.finish(id, state, 'Invalid option.');
    const view = await this.view(state, obligationId);
    if (view.payable <= 0n) return this.finish(id, state, 'This fee has a payment in progress or is already paid.');
    const base: SessionState = { ...state, obligationId, feeName: view.obligation.feeName, min: view.minInstalment.toString(), max: view.payable.toString() };
    if (view.obligation.allowInstalments && view.minInstalment < view.payable) {
      const pageData = this.amountPageData(base);
      await this.save(id, { ...base, expect: PAGES.enterAmount });
      return go(PAGES.enterAmount, pageData);
    }
    return this.toConfirm(id, { ...base, amount: view.payable.toString() });
  }

  private async enterAmount(id: string, state: SessionState, input: string): Promise<ExchangeReply> {
    const amount = parseSleInput(input);
    const min = BigInt(state.min!);
    const max = BigInt(state.max!);
    if (amount === null || amount < min || amount > max) {
      const attempts = state.amountAttempts + 1;
      if (attempts > MAX_AMOUNT_RETRIES) return this.finish(id, state, `Amount must be between ${sleShort(min)} and ${sleShort(max)}.`);
      return this.offerRetry(id, { ...state, amountAttempts: attempts }, `Enter an amount from ${sleShort(min)} to ${sleShort(max)}.`, PAGES.enterAmount, this.amountPageData(state));
    }
    return this.toConfirm(id, { ...state, amount: amount.toString() });
  }

  private async confirmPayment(id: string, subscriberId: string, state: SessionState, input: string): Promise<ExchangeReply> {
    if (input !== 'confirm') {
      await this.save(id, { ...state, expect: 'done' });
      return go(PAGES.paymentCancelled);
    }
    const payer = await this.payer(state);
    const payingNumber = payer.phone && ussdSubscriberIdFor(payer.phone) === subscriberId ? payer.phone : null;
    const account = await this.prisma.obligation.findUnique({
      where: { id: state.obligationId! },
      select: { fee: { select: { name: true, feeType: { select: { account: true } } } } },
    });
    const fa = account?.fee.feeType.account;
    if (!fa?.uvan) return this.finish(id, state, 'This fee cannot be paid by USSD right now. Please contact the finance office.');

    const payment = await this.initiate.execute({
      clientId: USSD_CLIENT_ID,
      obligationId: state.obligationId!,
      amount: BigInt(state.amount!),
      // The number paying is the one dialling. Monime only gives us an opaque
      // subscriberId (uuidv5 of the number), so we know it only when it's the
      // portal phone; otherwise settlement records what Monime reports.
      payerPhone: payingNumber,
      phoneAuthorized: false,
      channel: 'USSD',
      collection: 'USSD_FLOW',
      // Spec: idempotency key = USSD session id + step.
      idempotencyKey: `${id}:${PAGES.confirmPayment}`,
    });
    await this.save(id, { ...state, paymentId: payment.id, expect: 'done' });
    const amountDisplay = sleShort(payment.amount);
    return go(PAGES.makePayment, {
      // collect_payment template_data (see the flow template)
      amount: toMajorAmount(payment.amount),
      // TODO(monime): confirm payment_target_ref is the destination account's UVAN.
      payment_target_ref: fa.uvan,
      reference: payment.id,
      receipt_name: state.feeName!.slice(0, 40),
      payment_id: payment.id,
      financial_account_id: fa.monimeId,
      // labels. payment_started is reached by `next`, not an exchange, so it gets
      // no page data: its text is static in the flow template.
      fee_name: state.feeName!,
      amount_display: amountDisplay,
      payment_ref: payment.paymentRef,
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async toConfirm(id: string, state: SessionState): Promise<ExchangeReply> {
    const payer = await this.payer(state);
    await this.save(id, { ...state, expect: PAGES.confirmPayment });
    return go(PAGES.confirmPayment, { payer_name: maskName(payer.fullName), fee_name: state.feeName!, amount_display: sleShort(BigInt(state.amount!)) });
  }

  private amountPageData(state: SessionState): Record<string, unknown> {
    return { fee_name: state.feeName!, min_display: sleShort(BigInt(state.min!)), max_display: sleShort(BigInt(state.max!)) };
  }

  private async offerRetry(id: string, state: SessionState, message: string, pageId: PageId, pageData: Record<string, unknown>): Promise<ExchangeReply> {
    await this.save(id, { ...state, expect: PAGES.tryAgain, retry: { pageId, pageData } });
    return go(PAGES.tryAgain, { message });
  }

  private async finish(id: string, state: SessionState, message: string): Promise<ExchangeReply> {
    await this.save(id, { ...state, expect: 'done' });
    return stop(message);
  }

  private async balanceText(payer: Payer): Promise<string> {
    const views = await this.obligations.forPayer(payer);
    const lines = views.filter((v) => v.balance > 0n).map((v) => `${v.obligation.feeName}: ${sleShort(v.balance)}`);
    return lines.length ? `${maskName(payer.fullName)}\n${lines.join('\n')}` : `${maskName(payer.fullName)}: all clear.`;
  }

  /** Status by our payment ref or Monime's order number; rate-limited like ID lookups. */
  private async enterPaymentRef(id: string, subscriberId: string, state: SessionState, input: string): Promise<ExchangeReply> {
    if ((await this.lookupsInWindow(subscriberId)) >= this.config.get('USSD_MAX_LOOKUPS_PER_15_MIN')) {
      return stop('Too many lookups. Please try again later.');
    }
    await this.prisma.ussdSession.update({ where: { id }, data: { lookups: { increment: 1 } } });
    const view = await this.paymentStatus.byPublicRef(input);
    if (!view) {
      const attempts = state.idAttempts + 1;
      if (attempts > MAX_ID_RETRIES) return this.finish(id, state, 'Payment not found. Check the ref and try again later.');
      const shown = input.trim().slice(0, 20) || '(empty)';
      return this.offerRetry(id, { ...state, idAttempts: attempts }, `Payment ${shown} not found.`, PAGES.enterPaymentRef, {});
    }
    return this.finish(id, state, paymentStatusText(view));
  }

  private async payer(state: SessionState): Promise<Payer> {
    const p = await this.prisma.payer.findUnique({ where: { kind_ref: { kind: state.kind!, ref: state.ref! } } });
    if (!p) throw new DomainError('PAYER_NOT_FOUND', 'Payer not found');
    return p;
  }

  private async view(state: SessionState, obligationId: string) {
    const v = (await this.obligations.forPayer(await this.payer(state))).find((x) => x.obligation.id === obligationId);
    if (!v) throw new DomainError('NOT_FOUND', 'Fee not found');
    return v;
  }

  private async lookupsInWindow(subscriberId: string): Promise<number> {
    const r = await this.prisma.ussdSession.aggregate({
      where: { subscriberId, createdAt: { gt: new Date(Date.now() - 15 * 60_000) } },
      _sum: { lookups: true },
    });
    return r._sum.lookups ?? 0;
  }

  private save(id: string, state: SessionState) {
    return this.prisma.ussdSession.update({ where: { id }, data: { state: json(state) } });
  }
}

const json = (s: SessionState) => s as unknown as Prisma.InputJsonValue;

/** Short, payer-facing text for domain errors (USSD screens are tiny). */
function friendly(err: DomainError): string {
  switch (err.code) {
    case 'UPSTREAM_UNAVAILABLE': return 'Service busy. Please try again later.';
    case 'OBLIGATION_SETTLED':
    case 'AMOUNT_BELOW_MIN_INSTALMENT':
    case 'AMOUNT_EXCEEDS_PAYABLE': return err.message;
    case 'INVALID_STATE':
      return /in progress/.test(err.message) ? 'A payment for this fee is already in progress.' : 'This fee cannot be paid right now. Please contact the finance office.';
    default: return 'Something went wrong. Please try again.';
  }
}

const STATUS_LINE: Record<PaymentStatusView['status'], string> = {
  COMPLETED: 'PAID',
  PENDING: 'PENDING - waiting for confirmation',
  INITIATED: 'PENDING - waiting for confirmation',
  EXPIRED: 'NOT COMPLETED (expired). If money left your wallet it will be applied automatically.',
  FAILED: 'FAILED. Nothing was applied.',
};

export function paymentStatusText(v: PaymentStatusView): string {
  return [
    `Payment ${v.paymentRef}: ${STATUS_LINE[v.status]}`,
    `${sleShort(v.amount)} ${v.feeName}`,
    `${v.maskedName} (${v.payerRef})`,
    ...(v.receiptNumber ? [`Receipt ${v.receiptNumber}`] : []),
  ].join('\n');
}
