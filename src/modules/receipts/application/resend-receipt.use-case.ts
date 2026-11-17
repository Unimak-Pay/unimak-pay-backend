import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import { DomainError } from '../../../shared/domain/errors';
import { formatSle } from '../../../shared/domain/money';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { OutboxDispatcher } from '../../outbox/application/outbox-dispatcher';
import { OutboxWriter } from '../../outbox/application/outbox-writer';
import { ReceiptsQuery } from './receipts.query';

@Injectable()
export class ResendReceiptUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly receipts: ReceiptsQuery,
    private readonly outbox: OutboxWriter,
    private readonly dispatcher: OutboxDispatcher,
  ) {}

  /** Re-sends to the phone on record (never an arbitrary number). */
  async execute(number: string): Promise<{ queued: true }> {
    const r = await this.receipts.byNumber(number);
    if (!r) throw new DomainError('NOT_FOUND', 'Receipt not found');
    const keys = await this.outbox.enqueue(this.prisma, [
      {
        type: 'sms.receipt',
        dedupeKey: `sms.receipt:${r.number}:resend:${randomUUID()}`,
        payload: {
          phone: r.payerPhone,
          receiptNumber: r.number,
          text:
            `UNIMAK receipt ${r.number}: ${formatSle(r.amount)} for ${r.feeName} (${r.payerRef}). ` +
            `Verify: ${this.config.get('PUBLIC_BASE_URL')}/r/${r.verifyCode}`,
        },
      },
    ]);
    if (this.config.get('OUTBOX_DISPATCH_INLINE')) await this.dispatcher.dispatchKeys(keys);
    return { queued: true };
  }
}
