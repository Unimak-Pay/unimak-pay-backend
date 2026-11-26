import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { PAYMENT_REPOSITORY, type PaymentRecord, type PaymentRepository } from './payment.repository';

export interface PaymentHousekeeping {
  /** PROCESSING with nothing from Monime for 24 h → PENDING */
  processingReset: number;
  /** awaiting payment longer than PENDING_PAYMENT_RETENTION_DAYS → deleted */
  pendingDeleted: number;
}

/**
 * Payments don't expire (docs/payment-lifecycle.md). The cleanup cron only puts stale
 * PROCESSING payments back to PENDING and deletes payments still awaiting payment
 * after the retention period. Deletions are audited.
 */
@Injectable()
export class ExpirePaymentsUseCase {
  private readonly logger = new Logger(ExpirePaymentsUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
  ) {}

  async execute(now = new Date()): Promise<PaymentHousekeeping> {
    const processingReset = await this.payments.resetStaleProcessing(now);
    if (processingReset) this.logger.warn(`${processingReset} PROCESSING payment(s) had no completion within 24 h; back to PENDING`);
    const before = new Date(now.getTime() - this.config.get('PENDING_PAYMENT_RETENTION_DAYS') * 86_400_000);
    const deleted = await this.prisma.$transaction(async (tx) => {
      const rows = await this.payments.deleteAwaitingPayment({ createdBefore: before }, tx);
      await auditDeleted(this.audit, rows, 'retention', tx);
      return rows;
    });
    return { processingReset, pendingDeleted: deleted.length };
  }
}

/** One audit row per deleted payment, with what it was. */
export async function auditDeleted(audit: AuditService, rows: readonly PaymentRecord[], reason: string, tx: Parameters<AuditService['record']>[1]): Promise<void> {
  for (const p of rows) {
    await audit.record({
      actorId: 'system', action: 'payment.delete_awaiting', entity: 'Payment', entityId: p.id,
      before: { paymentRef: p.paymentRef, obligationId: p.obligationId, amount: p.amount.toString(), status: p.status, channel: p.channel, createdAt: p.createdAt.toISOString(), monimeRef: p.monimeRef },
      after: { reason },
    }, tx);
  }
}
