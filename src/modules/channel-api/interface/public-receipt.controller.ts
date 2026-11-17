import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { maskName } from '../../../shared/domain/mask';
import { formatSle } from '../../../shared/domain/money';
import { ReceiptsQuery } from '../../receipts/application/receipts.query';
import { isVerifyCodeShape } from '../../receipts/domain/receipt';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}
h1{font-size:1.25rem}.ok{color:#0a7a2f}.bad{color:#b00020}dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem}dt{color:#555}dd{margin:0}</style>
</head><body>${body}</body></html>`;

/** Public, unauthenticated receipt check: GET /r/:verifyCode */
@Controller('r')
export class PublicReceiptController {
  constructor(private readonly receipts: ReceiptsQuery) {}

  @Get(':verifyCode')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async verify(@Param('verifyCode') code: string, @Res() res: Response): Promise<void> {
    const r = isVerifyCodeShape(code) ? await this.receipts.byVerifyCode(code) : null;
    if (!r) {
      res.status(404).send(page('Receipt not found', `<h1 class="bad">✗ Receipt not found</h1><p>This code does not match any UNIMAK receipt.</p>`));
      return;
    }
    res.send(
      page(
        `Receipt ${r.number}`,
        `<h1 class="ok">✓ Valid UNIMAK receipt</h1><dl>
<dt>Receipt</dt><dd>${esc(r.number)}</dd>
<dt>Amount</dt><dd>${esc(formatSle(r.amount))}</dd>
<dt>For</dt><dd>${esc(r.feeName)} (${esc(r.period)})</dd>
<dt>Payer</dt><dd>${esc(maskName(r.payerName))} · ${esc(r.payerRef)}</dd>
<dt>Paid</dt><dd>${esc(r.issuedAt.toISOString().replace('T', ' ').slice(0, 16))} UTC</dd>
</dl>`,
      ),
    );
  }
}
