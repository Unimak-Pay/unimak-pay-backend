import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../../shared/infrastructure/prisma.service';
import {
  type InitiateCollectionInput,
  type InitiateCollectionResult,
  type MonimeClient,
  MonimeError,
  type MonimePaymentStatus,
  type MonimePaymentView,
  type TransferInput,
  type TransferResult,
} from './monime.port';

interface CollectionData {
  reference: string;
  payerPhone: string;
  channel: string;
  settlementAccount: string;
  description: string;
  expiresAt: string;
  metadata: Record<string, string>;
}

/**
 * Records collections and transfers in the MockMonimeRecord table (in-memory
 * state wouldn't survive between serverless invocations). Payments stay PENDING
 * until completed or failed through POST /dev/monime/simulate-webhook.
 */
export class MockMonimeClient implements MonimeClient {
  constructor(private readonly prisma: PrismaService) {}

  async initiateCollection(input: InitiateCollectionInput): Promise<InitiateCollectionResult> {
    const id = `mock_col_${input.reference}`;
    const data: CollectionData = {
      reference: input.reference,
      payerPhone: input.payerPhone,
      channel: input.channel,
      settlementAccount: input.settlementAccount,
      description: input.description,
      expiresAt: input.expiresAt.toISOString(),
      metadata: input.metadata,
    };
    // Idempotent on our reference, like the real API should be.
    const row = await this.prisma.mockMonimeRecord.upsert({
      where: { id },
      create: { id, kind: 'COLLECTION', status: 'PENDING', amount: input.amount, data: { ...data } },
      update: {},
    });
    return { monimeRef: row.id, status: row.status as MonimePaymentStatus };
  }

  async getPayment(monimeRef: string): Promise<MonimePaymentView> {
    const row = await this.prisma.mockMonimeRecord.findUnique({ where: { id: monimeRef } });
    if (!row || row.kind !== 'COLLECTION') {
      throw new MonimeError('NOT_FOUND', `Payment ${monimeRef} not found`, 404);
    }
    const data = row.data as unknown as CollectionData;
    return {
      monimeRef: row.id,
      reference: data.reference,
      status: row.status as MonimePaymentStatus,
      amount: row.amount,
    };
  }

  async transfer(input: TransferInput): Promise<TransferResult> {
    const id = `mock_trf_${input.idempotencyKey}`;
    const row = await this.prisma.mockMonimeRecord.upsert({
      where: { id },
      create: {
        id,
        kind: 'TRANSFER',
        status: 'COMPLETED',
        amount: input.amount,
        data: {
          fromAccount: input.fromAccount,
          toAccount: input.toAccount,
          description: input.description,
          nonce: randomUUID(),
        },
      },
      update: {},
    });
    return { transferId: row.id, status: 'COMPLETED' };
  }

  /** Dev helper: set a collection's final status. Returns the updated view. */
  async settleCollection(
    monimeRef: string,
    status: Exclude<MonimePaymentStatus, 'PENDING'>,
  ): Promise<MonimePaymentView> {
    const existing = await this.getPayment(monimeRef);
    await this.prisma.mockMonimeRecord.update({ where: { id: monimeRef }, data: { status } });
    return { ...existing, status };
  }
}
