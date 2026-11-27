import { Inject, Injectable } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import { DomainError } from '../../../shared/domain/errors';
import type { Minor } from '../../../shared/domain/money';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { PayRequestsService } from '../../dot-extras/application/pay-requests.service';
import { cleanText, isPayable } from '../../dot-extras/domain/pay-request';
import {
  CHECKOUTS_PER_REQUEST_PER_HOUR, SPONSOR_CLIENT_ID, SPONSOR_NAME_MAX, type SponsorMethod, sponsorAmount, sponsorDue,
} from '../../dot-extras/domain/sponsor-checkout';
import { PayerObligationsQuery } from '../../payers/application/payer-obligations.query';
import { PAYER_REPOSITORY, type PayerRepository } from '../../payers/application/payer.repository';
import { InitiatePaymentUseCase } from '../../payments/application/initiate-payment.use-case';
import { PAYMENT_REPOSITORY, type PaymentRepository } from '../../payments/application/payment.repository';
import { PAYMENT_REF } from '../../payments/domain/payment-ref';

export interface SponsorPage {
  code: string;
  status: string;
  payable: boolean;
  firstName: string;
  programLine: string;
  feeName: string;
  message: string;
  recipientName: string | null;
  /** fixed amount to pay now; null = the sponsor types one */
  due: Minor | null;
  /** most an open request can take now */
  max: Minor;
  minInstalment: Minor;
  expiresAt: Date;
}

export interface StartSponsorCheckout {
  method: SponsorMethod;
  /** only for "whatever you can" requests */
  entered: Minor | null;
  name: string | null;
  /** the page's one-time form key */
  key: string;
}

export type SponsorPaymentState =
  | { state: 'waiting'; paymentRef: string }
  | { state: 'paid'; paymentRef: string; receiptNumber: string; verifyUrl: string }
  | { state: 'failed'; paymentRef: string };

/**
 * The browser side of a pay request (docs/dot-extras.md §3a). The sponsor picks card or
 * mobile money; we record a PENDING payment towards the request and send them to a Monime
 * checkout session for that method. Only Monime's payment.completed settles it.
 */
@Injectable()
export class SponsorCheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly requests: PayRequestsService,
    private readonly obligations: PayerObligationsQuery,
    private readonly initiate: InitiatePaymentUseCase,
    @Inject(PAYER_REPOSITORY) private readonly payers: PayerRepository,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
  ) {}

  async page(code: string, now = new Date()): Promise<SponsorPage> {
    return (await this.load(code, now)).page;
  }

  /** Returns Monime's hosted page to redirect to. */
  async start(code: string, input: StartSponsorCheckout, now = new Date()): Promise<{ redirectUrl: string; paymentRef: string }> {
    const { id, page, requested, paid, payable } = await this.load(code, now);
    if (!page.payable) throw new DomainError('INVALID_STATE', page.status === 'PAID' ? 'This request has already been paid.' : 'This request is closed.');
    const amount = sponsorAmount({ requested, paid, payable, entered: input.entered });
    if (!amount.ok) throw new DomainError('VALIDATION', amount.message);

    const key = `${page.code}:${input.key}:${input.method}`;
    const replay = await this.payments.byIdempotencyKey(SPONSOR_CLIENT_ID, key);
    if (!replay) {
      const recent = await this.prisma.payment.count({ where: { payRequestId: id, channel: 'WEB', createdAt: { gte: new Date(now.getTime() - 3_600_000) } } });
      if (recent >= CHECKOUTS_PER_REQUEST_PER_HOUR) throw new DomainError('RATE_LIMITED', 'Too many payment attempts on this link. Try again in an hour.');
    }
    const obligationId = (await this.prisma.payRequest.findUniqueOrThrow({ where: { id }, select: { obligationId: true } })).obligationId;
    const base = this.config.get('PUBLIC_BASE_URL').replace(/\/+$/, '');
    const p = await this.initiate.execute({
      clientId: SPONSOR_CLIENT_ID,
      obligationId,
      amount: replay?.amount ?? amount.amount,
      payerPhone: null,
      phoneAuthorized: false,
      channel: 'WEB',
      idempotencyKey: key,
      collection: 'CHECKOUT_SESSION',
      payRequestId: id,
      paidByName: cleanText(input.name)?.slice(0, SPONSOR_NAME_MAX) ?? null,
      payingForSelf: false,
      checkout: {
        method: input.method,
        name: `UNIMAK · ${page.feeName}`,
        lineItemName: `${page.feeName} for ${page.firstName}`,
        successUrl: (x) => `${base}/p/${page.code}/done?ref=${x.paymentRef}`,
        cancelUrl: () => `${base}/p/${page.code}`,
      },
    }, now);
    if (p.status === 'FAILED' || !p.checkoutUrl) throw new DomainError('UPSTREAM_UNAVAILABLE', 'The payment page could not be opened. Please try again.');
    return { redirectUrl: p.checkoutUrl, paymentRef: p.paymentRef };
  }

  /** After Monime sends the sponsor back: has its confirmation arrived? */
  async state(code: string, paymentRef: string): Promise<SponsorPaymentState | null> {
    if (!PAYMENT_REF.test(paymentRef)) return null;
    const p = await this.payments.byPaymentRef(paymentRef);
    const req = p?.payRequestId ? await this.prisma.payRequest.findUnique({ where: { id: p.payRequestId }, select: { code: true } }) : null;
    if (!p || req?.code !== code.toUpperCase()) return null;
    if (p.status === 'FAILED') return { state: 'failed', paymentRef };
    if (p.status !== 'COMPLETED') return { state: 'waiting', paymentRef };
    const r = await this.prisma.receipt.findUnique({ where: { paymentId: p.id }, select: { number: true, verifyCode: true } });
    if (!r) return { state: 'waiting', paymentRef };
    const base = this.config.get('PUBLIC_BASE_URL').replace(/\/+$/, '');
    return { state: 'paid', paymentRef, receiptNumber: r.number, verifyUrl: `${base}/r/${r.verifyCode}` };
  }

  private async load(code: string, now: Date) {
    const r = await this.requests.forSponsor(code, now);
    const payer = await this.payers.find(r.payer.kind, r.payer.ref);
    const ob = payer ? (await this.obligations.forPayer(payer, now)).find((v) => v.obligation.id === r.view.obligationId) : undefined;
    const payable = ob?.payable ?? 0n;
    const v = r.view;
    return {
      id: r.id,
      requested: r.requested,
      paid: r.paid,
      payable,
      page: {
        code: v.code,
        status: v.status,
        payable: isPayable(v.status) && payable > 0n,
        firstName: v.requester.firstName,
        programLine: v.requester.programLine,
        feeName: v.feeName,
        message: v.message,
        recipientName: v.recipientName,
        due: sponsorDue(r.requested, r.paid, payable),
        max: payable,
        minInstalment: ob?.minInstalment ?? 0n,
        expiresAt: new Date(v.expiresAt),
      } satisfies SponsorPage,
    };
  }
}
