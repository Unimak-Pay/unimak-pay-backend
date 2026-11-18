import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError } from '../../../shared/domain/errors';
import type { Minor } from '../../../shared/domain/money';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { MONIME_CLIENT, type MonimeClient, MonimeError } from '../../integrations/monime/monime.port';
import { assertCanManagePayouts, assertPayoutAffordable, payoutStatusFromMonime } from '../domain/payout-policy';

export interface Actor {
  id: string;
  permissions: readonly string[];
}

export interface RequestPayoutInput {
  /** our account reference (e.g. unimak-fee-tuition) or Monime id (fac-…) */
  account: string;
  amount: Minor;
  bankProviderId: string;
  accountNumber: string;
  accountName?: string;
  narration?: string;
  idempotencyKey: string;
}

type PayoutRow = Prisma.PayoutGetPayload<object>;

/**
 * Withdraws funds from one of our Monime accounts to a bank account.
 * 1. permission payouts.manage; bank must be active and payout-capable (GET /v1/banks)
 * 2. under a row lock on the account: available (Monime) − our not-yet-submitted
 *    payouts must cover the amount → Payout REQUESTED
 * 3. after commit: POST /v1/payouts (Idempotency-Key = payout id) → SUBMITTED.
 *    Monime unreachable → stays REQUESTED; retry with the same idempotencyKey.
 * Completion/failure arrives via payout.completed / payout.failed webhooks.
 */
@Injectable()
export class RequestPayoutUseCase {
  private readonly logger = new Logger(RequestPayoutUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(MONIME_CLIENT) private readonly monime: MonimeClient,
  ) {}

  async execute(actor: Actor, input: RequestPayoutInput): Promise<PayoutRow> {
    assertCanManagePayouts(actor.permissions);
    const existing = await this.prisma.payout.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return this.replay(existing, input);

    if (!/^\d{4,34}$/.test(input.accountNumber)) throw new DomainError('VALIDATION', 'Bank account number must be 4–34 digits');
    const bank = (await this.monime.listBanks('SL')).find((b) => b.providerId === input.bankProviderId);
    if (!bank?.active || !bank.canPayTo) {
      throw new DomainError('VALIDATION', `Bank ${input.bankProviderId} is not available for payouts`);
    }

    const account = await this.prisma.financialAccount.findFirst({
      where: { OR: [{ reference: input.account }, { monimeId: input.account }] },
    });
    if (!account) throw new DomainError('NOT_FOUND', `Financial account ${input.account} not found`);

    let payout: PayoutRow;
    try {
      payout = await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "FinancialAccount" WHERE id = ${account.id}::uuid FOR UPDATE`;
          const remote = await this.monime.getFinancialAccount(account.monimeId, { withBalance: true });
          const available = remote.available ?? 0n;
          await tx.financialAccount.update({ where: { id: account.id }, data: { availableBalance: available, balanceUpdatedAt: new Date() } });
          const reserved = await tx.payout.aggregate({
            where: { financialAccountId: account.id, status: 'REQUESTED' },
            _sum: { amount: true },
          });
          assertPayoutAffordable({ amount: input.amount, available, reservedLocally: reserved._sum.amount ?? 0n });
          const created = await tx.payout.create({
            data: {
              financialAccountId: account.id,
              amount: input.amount,
              destinationType: 'bank',
              providerId: input.bankProviderId,
              accountNumber: input.accountNumber,
              accountName: input.accountName ?? null,
              narration: input.narration ?? null,
              requestedBy: actor.id,
              idempotencyKey: input.idempotencyKey,
            },
          });
          await this.audit.record({ actorId: actor.id, action: 'payout.request', entity: 'Payout', entityId: created.id, after: created }, tx);
          return created;
        },
        { timeout: 20_000 },
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.prisma.payout.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        if (winner) return this.replay(winner, input);
      }
      throw err;
    }
    return this.submit(payout, account.monimeId);
  }

  private async replay(p: PayoutRow, input: RequestPayoutInput): Promise<PayoutRow> {
    if (p.amount !== input.amount || p.providerId !== input.bankProviderId || p.accountNumber !== input.accountNumber) {
      throw new DomainError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used for a different payout');
    }
    if (p.status !== 'REQUESTED') return p;
    const account = await this.prisma.financialAccount.findUniqueOrThrow({ where: { id: p.financialAccountId } });
    return this.submit(p, account.monimeId);
  }

  private async submit(p: PayoutRow, sourceAccountId: string): Promise<PayoutRow> {
    try {
      const res = await this.monime.createPayout({
        idempotencyKey: p.id,
        amount: p.amount,
        sourceAccountId,
        destination: { type: 'bank', providerId: p.providerId, accountNumber: p.accountNumber },
        metadata: { payoutId: p.id, requestedBy: p.requestedBy, ...(p.narration ? { narration: p.narration } : {}) },
      });
      const status = payoutStatusFromMonime(res.status);
      const r = await this.prisma.payout.updateMany({
        where: { id: p.id, status: 'REQUESTED' },
        data: {
          monimePayoutId: res.id,
          status,
          ...(status === 'COMPLETED' ? { completedAt: new Date(), fees: res.fees } : {}),
          ...(res.failure ? { failureCode: res.failure.code, failureMessage: res.failure.message } : {}),
        },
      });
      if (r.count === 0) this.logger.log(`Payout ${p.id} already moved on (webhook first)`);
    } catch (err) {
      if (err instanceof MonimeError && err.code === 'REJECTED') {
        await this.prisma.payout.update({ where: { id: p.id }, data: { status: 'FAILED', failureCode: 'rejected', failureMessage: err.message.slice(0, 500) } });
      } else {
        this.logger.error(`Payout ${p.id} submit failed: ${(err as Error).message}`);
        throw new DomainError('UPSTREAM_UNAVAILABLE', 'Monime unavailable; retry with the same idempotencyKey', { payoutId: p.id });
      }
    }
    return this.prisma.payout.findUniqueOrThrow({ where: { id: p.id } });
  }
}
