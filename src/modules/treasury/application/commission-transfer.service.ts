import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { MONIME_CLIENT, type MonimeClient, MonimeError } from '../../integrations/monime/monime.port';
import type { CommissionTransferPayload } from '../../outbox/domain/messages';
import { PlatformAccount } from './platform-account';

const STATUS = { pending: 'SUBMITTED', processing: 'SUBMITTED', completed: 'COMPLETED', failed: 'FAILED' } as const;

/**
 * Moves the platform commission of one payment from the fee type's account to
 * the platform account (POST /v1/internal-transfers). Idempotent on the payment
 * id: a Transfer row per payment, and the same Idempotency-Key on every retry.
 * Throws on transient errors so the outbox retries with backoff.
 */
@Injectable()
export class CommissionTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly platform: PlatformAccount,
    @Inject(MONIME_CLIENT) private readonly monime: MonimeClient,
  ) {}

  async send(p: CommissionTransferPayload): Promise<void> {
    const destination = await this.platform.monimeId();
    if (!destination) throw new Error('No platform financial account (run pnpm monime:provision or set PLATFORM_MONIME_ACCOUNT)');

    const transfer = await this.prisma.transfer.upsert({
      where: { paymentId: p.paymentId },
      create: { kind: 'COMMISSION', paymentId: p.paymentId, sourceAccount: p.fromAccount, destinationAccount: destination, amount: BigInt(p.amount) },
      update: {},
    });
    if (transfer.monimeTransferId || transfer.status === 'COMPLETED') return;

    try {
      const res = await this.monime.createInternalTransfer({
        // a failed transfer's key can't be reused, so admin retries get a new one
        idempotencyKey: transfer.attempt === 1 ? `commission-${p.paymentId}` : `commission-${p.paymentId}-${transfer.attempt}`,
        amount: transfer.amount,
        sourceAccountId: transfer.sourceAccount,
        destinationAccountId: transfer.destinationAccount,
        metadata: { transferId: transfer.id, paymentId: p.paymentId, kind: 'commission', attempt: String(transfer.attempt) },
      });
      const status = STATUS[res.status];
      await this.prisma.transfer.updateMany({
        // a webhook may already have finished it
        where: { id: transfer.id, status: { in: ['PENDING', 'SUBMITTED'] } },
        data: {
          monimeTransferId: res.id,
          status,
          ...(status === 'COMPLETED' ? { completedAt: new Date() } : {}),
          ...(res.failure ? { failureCode: res.failure.code, failureMessage: res.failure.message } : {}),
        },
      });
    } catch (err) {
      if (err instanceof MonimeError) {
        await this.prisma.transfer.update({ where: { id: transfer.id }, data: { failureMessage: `${err.code}: ${err.message}`.slice(0, 500) } });
      }
      throw err;
    }
  }
}
