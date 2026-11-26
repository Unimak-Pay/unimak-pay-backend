import { Controller, Get, Header, Param, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ClearanceService } from '../../dot-extras/application/clearance.service';
import { DotRateLimitGuard } from './dot-rate-limit.guard';
import { esc, page } from './public-page';

/**
 * Public exam-pass check an invigilator's scanner opens: GET /c/:passCode. It re-checks
 * clearance now, every time, so a screenshot of an old pass can't be reused once the
 * status changes. No phone, no amounts.
 */
@Controller('c')
@UseGuards(DotRateLimitGuard)
export class PublicClearanceController {
  constructor(private readonly clearance: ClearanceService) {}

  @Get(':code')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async check(@Param('code') code: string, @Res() res: Response): Promise<void> {
    const r = await this.clearance.checkPass(code.slice(0, 20));
    if (!r) {
      res.status(404).send(page('Pass not found', `<h1 class="bad">✗ Pass not found</h1><p>This code does not match any UNIMAK exam pass.</p>`));
      return;
    }
    const checked = `${r.checkedAt.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
    const head = r.valid
      ? `<h1 class="ok">✓ Cleared for ${esc(r.examName)} (${esc(r.period)})</h1>`
      : `<h1 class="bad">✗ Not cleared for ${esc(r.examName)} (${esc(r.period)})</h1><p>${esc(r.reason ?? '')}. Send the student to the finance office.</p>`;
    res.send(page(r.valid ? 'Exam pass: cleared' : 'Exam pass: not cleared', `${head}<dl>
<dt>Student</dt><dd>${esc(r.fullName)}</dd>
<dt>ID</dt><dd>${esc(r.ref)}</dd>
<dt>Programme</dt><dd>${esc(r.programLine)}</dd>
<dt>Checked</dt><dd>${esc(checked)} (live, not a saved copy)</dd>
</dl>`));
  }
}
