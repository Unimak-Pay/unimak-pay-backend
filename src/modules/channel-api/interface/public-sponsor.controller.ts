import { randomBytes } from 'node:crypto';
import { Body, Controller, Get, Header, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from '../../../shared/domain/errors';
import { formatSle } from '../../../shared/domain/money';
import { isCheckoutKey, isSponsorMethod, parseSleInput } from '../../dot-extras/domain/sponsor-checkout';
import { type SponsorPage, SponsorCheckoutService } from '../application/sponsor-checkout.service';
import { DotRateLimitGuard } from './dot-rate-limit.guard';
import { esc, page } from './public-page';

const STYLE = `<style>form{margin-top:1.5rem}label{display:block;margin:.75rem 0 .25rem;color:#555}
input{font:inherit;width:100%;box-sizing:border-box;padding:.6rem;border:1px solid #bbb;border-radius:.4rem}
button{font:inherit;display:block;width:100%;margin-top:.75rem;padding:.8rem;border:0;border-radius:.4rem;background:#13261F;color:#fff;cursor:pointer}
button.alt{background:#fff;color:#13261F;border:1px solid #13261F}.note{color:#555;font-size:.9rem}.err{color:#b00020}
blockquote{margin:1rem 0;padding:.5rem 1rem;border-left:3px solid #A8741F;color:#333}</style>`;

const CLOSED: Record<string, string> = {
  PAID: 'This request has already been paid. Thank you!',
  CANCELLED: 'The student cancelled this request.',
  EXPIRED: 'This request has expired. Ask the student for a new link.',
};

/** What a body of the checkout form may hold (urlencoded). */
interface CheckoutForm {
  method?: unknown;
  amount?: unknown;
  name?: unknown;
  key?: unknown;
}

/**
 * The pay request link a sponsor opens in any browser: GET /p/{code}. They pick mobile
 * money or card; POST /p/{code}/checkout sends them to Monime's hosted page for that
 * method; Monime brings them back to /p/{code}/done. Shows the student's first name and
 * programme only.
 */
@Controller('p')
@UseGuards(DotRateLimitGuard)
export class PublicSponsorController {
  constructor(private readonly sponsor: SponsorCheckoutService) {}

  @Get(':code')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async show(@Param('code') code: string, @Res() res: Response): Promise<void> {
    await this.render(res, code.slice(0, 20));
  }

  @Post(':code/checkout')
  @Header('Cache-Control', 'no-store')
  async checkout(@Param('code') code: string, @Body() form: CheckoutForm, @Res() res: Response): Promise<void> {
    const c = code.slice(0, 20);
    if (!isSponsorMethod(form.method) || !isCheckoutKey(form.key)) {
      await this.render(res, c, 'Please choose mobile money or card.', 400);
      return;
    }
    const entered = typeof form.amount === 'string' && form.amount.trim() ? parseSleInput(form.amount) : null;
    if (typeof form.amount === 'string' && form.amount.trim() && entered === null) {
      await this.render(res, c, 'Enter the amount in leones, for example 500 or 500.50.', 400);
      return;
    }
    try {
      const r = await this.sponsor.start(c, { method: form.method, entered, name: typeof form.name === 'string' ? form.name : null, key: form.key });
      res.redirect(303, r.redirectUrl);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'RATE_LIMITED' ? 429 : err.code === 'UPSTREAM_UNAVAILABLE' ? 503 : err.code === 'INVALID_STATE' ? 409 : 400;
      await this.render(res, c, err.message, status);
    }
  }

  @Get(':code/done')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async done(@Param('code') code: string, @Query('ref') ref: string | undefined, @Res() res: Response): Promise<void> {
    const c = code.slice(0, 20);
    const s = typeof ref === 'string' ? await this.sponsor.state(c, ref.slice(0, 20)) : null;
    if (!s) {
      res.status(404).send(page('Payment not found', `<h1 class="bad">Payment not found</h1><p><a href="/p/${esc(encodeURIComponent(c))}">Back to the request</a></p>`, STYLE));
      return;
    }
    if (s.state === 'paid') {
      res.send(page('Payment received', `<h1 class="ok">✓ Payment received</h1><p>UNIMAK has recorded your payment. Thank you!</p><dl>
<dt>Receipt</dt><dd>${esc(s.receiptNumber)}</dd><dt>Payment</dt><dd>${esc(s.paymentRef)}</dd></dl>
<p><a href="${esc(s.verifyUrl)}">View the receipt</a></p>`, STYLE));
      return;
    }
    if (s.state === 'failed') {
      res.send(page('Payment not completed', `<h1 class="bad">Payment not completed</h1><p>No money was taken by UNIMAK for this attempt.</p><p><a href="/p/${esc(encodeURIComponent(c))}">Try again</a></p>`, STYLE));
      return;
    }
    res.send(page('Waiting for confirmation', `<h1>Waiting for confirmation…</h1><p>As soon as Monime confirms your payment, UNIMAK records it and your receipt appears here. This page refreshes by itself.</p>
<p class="note">Payment ${esc(s.paymentRef)}. If you closed the payment page without paying, <a href="/p/${esc(encodeURIComponent(c))}">go back to the request</a>.</p>`, `${STYLE}<meta http-equiv="refresh" content="5">`));
  }

  private async render(res: Response, code: string, error?: string, status = 200): Promise<void> {
    let p: SponsorPage;
    try {
      p = await this.sponsor.page(code);
    } catch (err) {
      if (!(err instanceof DomainError) || err.code !== 'NOT_FOUND') throw err;
      res.status(404).type('html').send(page('Request not found', `<h1 class="bad">Request not found</h1><p>This link does not match any UNIMAK payment request.</p>`, STYLE));
      return;
    }
    const head = `<h1>Pay ${esc(p.feeName)} for ${esc(p.firstName)}</h1>
<dl><dt>Student</dt><dd>${esc(p.firstName)}</dd><dt>Programme</dt><dd>${esc(p.programLine)}</dd><dt>Fee</dt><dd>${esc(p.feeName)}</dd>
${p.due !== null ? `<dt>Amount</dt><dd><strong>${esc(formatSle(p.due))}</strong></dd>` : ''}</dl>
${p.message ? `<blockquote>${esc(p.message)}</blockquote>` : ''}`;
    if (!p.payable) {
      res.status(status).type('html').send(page('Payment request', `${head}<p class="bad">${esc(CLOSED[p.status] ?? 'Nothing is left to pay on this fee.')}</p>`, STYLE));
      return;
    }
    const key = randomBytes(18).toString('base64url');
    const amountField = p.due === null
      ? `<label for="amount">Amount (SLE)</label><input id="amount" name="amount" inputmode="decimal" required placeholder="${esc(formatSle(p.max).replace('SLE ', ''))}">
<p class="note">Up to ${esc(formatSle(p.max))}${p.minInstalment > 0n ? `; at least ${esc(formatSle(p.minInstalment < p.max ? p.minInstalment : p.max))}` : ''}.</p>`
      : '';
    res.status(status).type('html').send(page(`Pay ${p.feeName} for ${p.firstName}`, `${head}
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/p/${esc(encodeURIComponent(p.code))}/checkout">
<input type="hidden" name="key" value="${key}">
${amountField}
<label for="name">Your name (optional, shown to ${esc(p.firstName)})</label><input id="name" name="name" maxlength="40" autocomplete="given-name">
<button name="method" value="momo">Pay with mobile money</button>
<button name="method" value="card" class="alt">Pay with card</button>
</form>
<p class="note">You pay on Monime's secure page. The money goes straight to UNIMAK, and you get a receipt once Monime confirms it. This request expires ${esc(p.expiresAt.toISOString().slice(0, 10))}.</p>`, STYLE));
  }
}
