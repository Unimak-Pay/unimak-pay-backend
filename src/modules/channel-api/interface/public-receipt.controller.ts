import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { maskName } from '../../../shared/domain/mask';
import { formatSle } from '../../../shared/domain/money';
import { ReceiptsQuery } from '../../receipts/application/receipts.query';
import { isVerifyCodeShape } from '../../receipts/domain/receipt';
import { esc, page } from './public-page';

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
