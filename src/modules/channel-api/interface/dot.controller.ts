import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from '../../../shared/domain/errors';
import { AcademicsService } from '../../academics/application/academics.service';
import type { PayerKind } from '../../catalog/domain/payer-profile';
import { LookupPayerUseCase } from '../../payers/application/lookup-payer.use-case';
import { PayerObligationsQuery } from '../../payers/application/payer-obligations.query';
import { InitiatePaymentUseCase } from '../../payments/application/initiate-payment.use-case';
import { PAYMENT_REPOSITORY, type PaymentRepository } from '../../payments/application/payment.repository';
import { PaymentStatusQuery } from '../../payments/application/payment-status.query';
import { QuotePaymentUseCase } from '../../payments/application/quote-payment.use-case';
import { shortName } from '../../../shared/domain/mask';
import { ClearanceService } from '../../dot-extras/application/clearance.service';
import { PaymentHistoryQuery } from '../../dot-extras/application/payment-history.query';
import { PayRequestsService } from '../../dot-extras/application/pay-requests.service';
import type { Payer } from '../../payers/domain/payer';
import { type AliasRequest, DotAliasCheck } from '../application/dot-alias-check';
import { clientIp, DotRateLimitGuard } from './dot-rate-limit.guard';
import { CreatePayRequestDto, DotAmountDto, DotPaymentDto, IDEMPOTENCY_KEY } from './dto';
import { PayerKindPipe, RefPipe } from './payer-kind.pipe';
import { presentDotOrder, presentDotPayer, presentObligation, presentPayment, presentPaymentStatus } from './presenters';

/** clientId recorded on payments started from the dot (idempotency scope). */
export const DOT_CLIENT_ID = 'dash-dot';

/**
 * Public API for the UNIMAK dot in Monime Dash. A dot's code is public, so there is
 * no secret: callers are limited per IP, phones are masked, and everything
 * that matters (amounts, the receiving account) is decided here. Money only moves
 * in Dash's payment sheet, and only Monime's webhook marks a payment COMPLETED.
 */
@Controller('v1/dot')
@UseGuards(DotRateLimitGuard)
export class DotController {
  constructor(
    private readonly lookup: LookupPayerUseCase,
    private readonly academics: AcademicsService,
    private readonly obligations: PayerObligationsQuery,
    private readonly quote: QuotePaymentUseCase,
    private readonly initiate: InitiatePaymentUseCase,
    private readonly paymentStatus: PaymentStatusQuery,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    private readonly alias: DotAliasCheck,
    private readonly payRequests: PayRequestsService,
    private readonly history: PaymentHistoryQuery,
    private readonly clearance: ClearanceService,
  ) {}

  /**
   * With a matching X-User-Alias (or none, from dots before 0.2.3): the full record. With
   * another number (a sponsor, "pay for others"): only what's needed to pay.
   */
  @Get('payers/:kind/:ref')
  async getPayer(@Param('kind', PayerKindPipe) kind: PayerKind, @Param('ref', RefPipe) ref: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { payer, stale } = await this.lookup.execute(kind, ref);
    const views = await this.obligations.forPayer(payer);
    if (this.alias.forLookup(aliasRequest(req, res), payer) === 'SHORT') {
      return { payer: { kind: payer.kind.toLowerCase(), ref: payer.ref, shortName: shortName(payer.fullName), limited: true, stale }, obligations: views.map(presentObligation) };
    }
    const names = await this.academics.names([payer.department]);
    return {
      payer: presentDotPayer(payer, stale, payer.department ? names.get(payer.department) : undefined),
      obligations: views.map(presentObligation),
    };
  }

  /** The payer, once X-User-Alias matches (history, requests, clearance). */
  private async matchedPayer(kind: PayerKind, ref: string, req: Request, res: Response): Promise<Payer> {
    const { payer } = await this.lookup.execute(kind, ref);
    this.alias.require(aliasRequest(req, res), payer);
    return payer;
  }

  @Post('quotes')
  @HttpCode(200)
  async postQuote(@Body() dto: DotAmountDto) {
    const q = await this.quote.execute({ obligationId: dto.obligationId, amount: BigInt(dto.amount), channel: 'DOTS' });
    return { amount: dto.amount, payable: q.position.payable.toString(), minInstalment: q.minInstalment.toString(), valid: true };
  }

  /**
   * Holds the amount and returns the order for `dash.payments.request()`. Idempotent on
   * the `Idempotency-Key` header: a retry returns the same payment and order.
   */
  @Post('payments')
  @HttpCode(201)
  async postPayment(@Headers('idempotency-key') key: string | undefined, @Body() dto: DotPaymentDto) {
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      throw new DomainError('VALIDATION', 'Idempotency-Key header must be 8-100 letters, digits or _.:-');
    }
    // optional (dot 0.2.3+); without them everything works as before
    const replay = dto.payRequestCode ? !!(await this.payments.byIdempotencyKey(DOT_CLIENT_ID, key)) : false;
    const payRequestId = dto.payRequestCode ? await this.payRequests.forPayment(dto.payRequestCode, dto.obligationId, new Date(), { replay }) : null;
    const paidByName = dto.paidByName ? firstNameOnly(dto.paidByName) : null;
    const p = await this.initiate.execute({
      payRequestId,
      paidByName,
      payingForSelf: dto.payingForSelf ?? false,
      clientId: DOT_CLIENT_ID,
      obligationId: dto.obligationId,
      amount: BigInt(dto.amount),
      payerPhone: null, // Monime reports the paying number in the webhook
      phoneAuthorized: false,
      channel: 'DOTS',
      collection: 'DASH_SHEET',
      idempotencyKey: key,
    });
    const o = (await this.payments.obligationInfo(p.obligationId))!;
    const v = presentPayment(p);
    return {
      paymentId: v.paymentId,
      paymentRef: v.paymentRef,
      status: v.status,
      amount: v.amount,
      expiresAt: v.expiresAt,
      order: presentDotOrder(p, o, dto.payRequestCode ? dto.payRequestCode.toUpperCase() : undefined),
      financialAccountId: o.settlementAccount!,
    };
  }

  /** By our 8-digit payment ref or Monime's order number; payer details masked. */
  @Get('payments/status/:ref')
  async getPaymentStatus(@Param('ref') ref: string) {
    const v = await this.paymentStatus.byPublicRef(ref.slice(0, 40));
    if (!v) throw new DomainError('NOT_FOUND', 'Payment not found');
    return presentPaymentStatus(v);
  }

  // ── History and receipts (docs/dot-extras.md §1-2) ──────────────────────────

  /** Every payment towards the payer's fees, newest first. X-User-Alias must match. */
  @Get('payers/:kind/:ref/payments')
  async paymentHistory(@Param('kind', PayerKindPipe) kind: PayerKind, @Param('ref', RefPipe) ref: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.history.forPayer(await this.matchedPayer(kind, ref, req, res));
  }

  /** By paymentRef (random, 8 digits); 404 until Monime completed the payment. */
  @Get('payments/:paymentRef/receipt')
  async receipt(@Param('paymentRef') paymentRef: string) {
    const r = await this.history.receipt(paymentRef.slice(0, 20));
    if (!r) throw new DomainError('NOT_FOUND', 'No receipt for this payment yet');
    return r;
  }

  // ── Exam clearance (docs/dot-extras.md §4) ──────────────────────────────────

  /** Live against the finance office's rule; a CLEARED pass links to the public /c/{code} check. */
  @Get('payers/:kind/:ref/clearance')
  async getClearance(@Param('kind', PayerKindPipe) kind: PayerKind, @Param('ref', RefPipe) ref: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (kind !== 'STUDENT') throw new DomainError('NOT_FOUND', 'Exam clearance is for students');
    return this.clearance.forPayer(await this.matchedPayer(kind, ref, req, res));
  }

  // ── Pay requests (docs/dot-extras.md §3) ───────────────────────────────────

  /** A student asks someone to pay. Idempotent on Idempotency-Key, like payments. */
  @Post('pay-requests')
  @HttpCode(201)
  async createPayRequest(@Headers('idempotency-key') key: string | undefined, @Body() dto: CreatePayRequestDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      throw new DomainError('VALIDATION', 'Idempotency-Key header must be 8-100 letters, digits or _.:-');
    }
    const payer = await this.matchedPayer(new PayerKindPipe().transform(dto.kind), dto.ref, req, res);
    return this.payRequests.create(payer, {
      obligationId: dto.obligationId,
      amount: dto.amount ? BigInt(dto.amount) : null,
      message: dto.message,
      recipientName: dto.recipientName ?? null,
      idempotencyKey: key,
    });
  }

  /** The sponsor's page. No alias match needed: the code is the secret. */
  @Get('pay-requests/:code')
  getPayRequest(@Param('code') code: string) {
    return this.payRequests.byCode(code.slice(0, 20));
  }

  @Get('payers/:kind/:ref/pay-requests')
  async listPayRequests(@Param('kind', PayerKindPipe) kind: PayerKind, @Param('ref', RefPipe) ref: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.payRequests.listFor(await this.matchedPayer(kind, ref, req, res));
  }
}

function aliasRequest(req: Request, res: Response): AliasRequest {
  return { alias: req.header('x-user-alias') ?? undefined, ip: clientIp(req), res };
}

/** "Fatmata Sesay" → "Fatmata": the dot is asked for a first name; keep only that. */
function firstNameOnly(s: string): string | null {
  const f = s.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().split(/\s+/)[0] ?? '';
  return f ? f.slice(0, 40) : null;
}
