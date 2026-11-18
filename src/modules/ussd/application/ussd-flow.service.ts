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
import { ReceiptsQuery } from '../../receipts/application/receipts.query';
import { ResendReceiptUseCase } from '../../receipts/application/resend-receipt.use-case';
import {
  type ExchangeReply, type ExchangeRequest, type Intent, MAX_AMOUNT_RETRIES, MAX_ID_RETRIES, PAGES, type PageId,
  parseSleInput, type SessionState, sleShort,
} from '../domain/flow';
import { msisdnMatchesSubscriber, toInternationalMsisdn } from '../domain/subscriber-id';

export const USSD_CLIENT_ID = 'ussd-flow';
const YES_NO = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
const stop = (message: string): ExchangeReply => ({ action: 'stop', message });
const go = (pageId: PageId, pageData: Record<string, unknown>): ExchangeReply => ({ action: 'navigate', pageId, pageData });

/**
 * The spec's USSD menu as a state machine (≤ 4 screens to start a payment):
 *   start → main_menu → id_type → enter_id → confirm_payer → select_fee
 *         → [enter_amount] → confirm_amount → share_number → stop("Dial … to pay")
 * flowData is untrusted: each page is only accepted when the server-side
 * session expects it, and every value is re-validated.
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
    private readonly receipts: ReceiptsQuery,
    private readonly resend: ResendReceiptUseCase,
  ) {}

  async handle(req: ExchangeRequest): Promise<ExchangeReply> {
    const { sessionId, subscriberId } = req.global;
    if (req.currentPage === PAGES.start) return this.start(sessionId, subscriberId);

    const session = await this.prisma.ussdSession.findUnique({ where: { id: sessionId } });
    if (!session || session.subscriberId !== subscriberId) return stop('Session expired. Please dial again.');
    const state = session.state as unknown as SessionState;
    if (req.currentPage !== state.expect) {
      this.logger.warn(`USSD session ${sessionId}: got page ${req.currentPage}, expected ${state.expect}`);
      return stop('Session expired. Please dial again.');
    }
    const input = (req.flowData[req.currentPage] ?? '').trim();

    try {
      switch (state.expect) {
        case PAGES.mainMenu: return await this.mainMenu(sessionId, state, input);
        case PAGES.idType: return await this.idType(sessionId, state, input);
        case PAGES.enterId: return await this.enterId(sessionId, subscriberId, state, input);
        case PAGES.confirmPayer: return await this.confirmPayer(sessionId, state, input);
        case PAGES.selectFee: return await this.selectFee(sessionId, state, input);
        case PAGES.enterAmount: return await this.enterAmount(sessionId, state, input);
        case PAGES.confirmAmount: return await this.confirmAmount(sessionId, state, input);
        case PAGES.shareNumber: return await this.shareNumber(req, state);
        default: return stop('Session expired. Please dial again.');
      }
    } catch (err) {
      if (err instanceof DomainError) return stop(friendly(err));
      throw err;
    }
  }

  // ── pages ──────────────────────────────────────────────────────────────────

  private async start(sessionId: string, subscriberId: string): Promise<ExchangeReply> {
    const state: SessionState = { expect: PAGES.mainMenu, idAttempts: 0, amountAttempts: 0 };
    await this.prisma.ussdSession.upsert({
      where: { id: sessionId },
      create: { id: sessionId, subscriberId, state: state as unknown as Prisma.InputJsonValue },
      update: { state: state as unknown as Prisma.InputJsonValue },
    });
    return go(PAGES.mainMenu, {
      message: 'UNIMAK Payments',
      items: [
        { value: 'pay', label: 'Pay a fee' },
        { value: 'balance', label: 'Check balance' },
        { value: 'resend', label: 'Resend last receipt' },
        { value: 'help', label: 'Help' },
      ],
    });
  }

  private async mainMenu(id: string, state: SessionState, input: string): Promise<ExchangeReply> {
    if (input === 'help') return stop(this.config.get('USSD_HELP_MESSAGE'));
    if (input !== 'pay' && input !== 'balance' && input !== 'resend') return stop('Invalid option.');
    await this.save(id, { ...state, intent: input as Intent, expect: PAGES.idType });
    return go(PAGES.idType, { message: 'Pay with', items: [{ value: 'student', label: 'Student ID' }, { value: 'applicant', label: 'Application No.' }] });
  }

  private async idType(id: string, state: SessionState, input: string): Promise<ExchangeReply> {
    if (input !== 'student' && input !== 'applicant') return stop('Invalid option.');
    const kind = input === 'student' ? 'STUDENT' : 'APPLICANT';
    await this.save(id, { ...state, kind, expect: PAGES.enterId });
    return go(PAGES.enterId, { message: kind === 'STUDENT' ? 'Enter Student ID' : 'Enter Application No.' });
  }

  private async enterId(id: string, subscriberId: string, state: SessionState, input: string): Promise<ExchangeReply> {
    // Stop people enumerating student IDs from one phone.
    if (await this.lookupsInWindow(subscriberId) >= this.config.get('USSD_MAX_LOOKUPS_PER_15_MIN')) {
      return stop('Too many lookups. Please try again later.');
    }
    await this.prisma.ussdSession.update({ where: { id }, data: { lookups: { increment: 1 } } });

    const ref = input.toUpperCase().replace(/\s+/g, '');
    let payer: Payer | null = null;
    if (/^[A-Z0-9-]{3,32}$/.test(ref)) {
      try {
        payer = (await this.lookup.execute(state.kind!, ref)).payer;
      } catch (err) {
        if (!(err instanceof DomainError) || err.code !== 'PAYER_NOT_FOUND') throw err;
      }
    }
    if (!payer) {
      const attempts = state.idAttempts + 1;
      if (attempts > MAX_ID_RETRIES) return stop('ID not found. Please check the number and try again.');
      await this.save(id, { ...state, idAttempts: attempts });
      return go(PAGES.enterId, { message: `ID not found. Enter it again (${MAX_ID_RETRIES - attempts + 1} left)` });
    }

    const next = { ...state, ref: payer.ref };
    if (state.intent === 'balance') return stop(await this.balanceText(payer));
    if (state.intent === 'resend') return stop(await this.resendLast(payer));
    await this.save(id, { ...next, expect: PAGES.confirmPayer });
    return go(PAGES.confirmPayer, { message: `${maskName(payer.fullName)} - ${programLine(payer)}`, items: YES_NO });
  }

  private async confirmPayer(id: string, state: SessionState, input: string): Promise<ExchangeReply> {
    if (input !== 'yes') return stop('Cancelled.');
    const payer = await this.payer(state);
    const open = (await this.obligations.forPayer(payer)).filter((v) => v.payable > 0n);
    if (open.length === 0) return stop('Nothing to pay right now. All clear!');
    const options = Object.fromEntries(open.slice(0, 8).map((v, i) => [String(i + 1), v.obligation.id]));
    await this.save(id, { ...state, feeOptions: options, expect: PAGES.selectFee });
    return go(PAGES.selectFee, {
      message: 'Select fee',
      items: open.slice(0, 8).map((v, i) => ({ value: String(i + 1), label: `${v.obligation.feeName} bal ${sleShort(v.payable)}` })),
    });
  }

  private async selectFee(id: string, state: SessionState, input: string): Promise<ExchangeReply> {
    const obligationId = state.feeOptions?.[input];
    if (!obligationId) return stop('Invalid option.');
    const view = await this.view(state, obligationId);
    if (view.payable <= 0n) return stop('This fee has a payment in progress or is already paid.');
    const base = { ...state, obligationId, min: view.minInstalment.toString(), max: view.payable.toString() };
    if (view.obligation.allowInstalments && view.minInstalment < view.payable) {
      await this.save(id, { ...base, expect: PAGES.enterAmount });
      return go(PAGES.enterAmount, { message: `Enter amount (min ${sleShort(view.minInstalment)}, max ${sleShort(view.payable)})` });
    }
    await this.save(id, { ...base, amount: view.payable.toString(), expect: PAGES.confirmAmount });
    return go(PAGES.confirmAmount, { message: `Pay ${sleShort(view.payable)} for ${view.obligation.feeName}?`, items: YES_NO });
  }

  private async enterAmount(id: string, state: SessionState, input: string): Promise<ExchangeReply> {
    const amount = parseSleInput(input);
    const min = BigInt(state.min!);
    const max = BigInt(state.max!);
    if (amount === null || amount < min || amount > max) {
      const attempts = state.amountAttempts + 1;
      if (attempts > MAX_AMOUNT_RETRIES) return stop(`Amount must be between ${sleShort(min)} and ${sleShort(max)}.`);
      await this.save(id, { ...state, amountAttempts: attempts });
      return go(PAGES.enterAmount, { message: `Enter ${sleShort(min)} to ${sleShort(max)}` });
    }
    await this.save(id, { ...state, amount: amount.toString(), expect: PAGES.confirmAmount });
    return go(PAGES.confirmAmount, { message: `Pay ${sleShort(amount)}?`, items: YES_NO });
  }

  private async confirmAmount(id: string, state: SessionState, input: string): Promise<ExchangeReply> {
    if (input !== 'yes') return stop('Cancelled.');
    await this.save(id, { ...state, expect: PAGES.shareNumber });
    // share_number is Monime's get_subscriber_msisdn consent template.
    return go(PAGES.shareNumber, {});
  }

  private async shareNumber(req: ExchangeRequest, state: SessionState): Promise<ExchangeReply> {
    const { sessionId, subscriberId } = req.global;
    const payer = await this.payer(state);
    // Only trust an exported number that hashes to this subscriber (uuidv5, as Monime derives subscriberId).
    const exported = String(req.exportedData?.['phone_number'] ?? '');
    const own = exported && msisdnMatchesSubscriber(exported, subscriberId) ? toInternationalMsisdn(exported) : null;
    if (exported && !own) this.logger.warn(`USSD session ${sessionId}: exported number does not match subscriber`);

    const payment = await this.initiate.execute({
      clientId: USSD_CLIENT_ID,
      obligationId: state.obligationId!,
      amount: BigInt(state.amount!),
      payerPhone: own ?? payer.phone,
      // Without consent we don't know who's paying (often a parent): leave the code open.
      phoneAuthorized: own !== null,
      channel: 'USSD',
      // Spec: idempotency key = USSD session id + step.
      idempotencyKey: `${sessionId}:${PAGES.shareNumber}`.slice(0, 100),
    });
    await this.prisma.ussdSession.update({ where: { id: sessionId }, data: { state: { ...state, expect: 'done' } as unknown as Prisma.InputJsonValue } });
    if (payment.status !== 'PENDING' || !payment.ussdCode) return stop('Payment could not be started. Please try again later.');
    const mins = Math.max(1, Math.round((payment.expiresAt.getTime() - Date.now()) / 60_000));
    return stop(`Dial ${payment.ussdCode} to pay ${sleShort(payment.amount)}. Valid ${mins} min. Receipt by SMS.`);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async balanceText(payer: Payer): Promise<string> {
    const views = await this.obligations.forPayer(payer);
    const lines = views.filter((v) => v.balance > 0n).map((v) => `${v.obligation.feeName}: ${sleShort(v.balance)}`);
    return lines.length ? `${maskName(payer.fullName)}\n${lines.join('\n')}` : `${maskName(payer.fullName)}: all clear.`;
  }

  private async resendLast(payer: Payer): Promise<string> {
    const [last] = await this.receipts.forPayer(payer.id);
    if (!last) return 'No receipts found.';
    await this.resend.execute(last.number);
    return `Receipt ${last.number} sent by SMS.`;
  }

  private async payer(state: SessionState): Promise<Payer> {
    const p = await this.prisma.payer.findUnique({ where: { kind_ref: { kind: state.kind!, ref: state.ref! } } });
    if (!p) throw new DomainError('PAYER_NOT_FOUND', 'Payer not found');
    return p;
  }

  private async view(state: SessionState, obligationId: string) {
    const payer = await this.payer(state);
    const v = (await this.obligations.forPayer(payer)).find((x) => x.obligation.id === obligationId);
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
    return this.prisma.ussdSession.update({ where: { id }, data: { state: state as unknown as Prisma.InputJsonValue } });
  }
}

/** Short, payer-facing text for domain errors (USSD screens are tiny). */
function friendly(err: DomainError): string {
  switch (err.code) {
    case 'UPSTREAM_UNAVAILABLE': return 'Service busy. Please try again later.';
    case 'OBLIGATION_SETTLED': return err.message;
    case 'INVALID_STATE': return /in progress/.test(err.message) ? 'A payment for this fee is already in progress.' : 'This fee cannot be paid right now. Please contact the finance office.';
    case 'AMOUNT_BELOW_MIN_INSTALMENT':
    case 'AMOUNT_EXCEEDS_PAYABLE': return err.message;
    default: return 'Something went wrong. Please try again.';
  }
}
