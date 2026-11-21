import { Controller, Get, UseGuards } from '@nestjs/common';
import { OutboxDispatcher } from '../outbox/application/outbox-dispatcher';
import { ExpirePaymentsUseCase } from '../payments/application/expire-payments.use-case';
import { PrismaService } from '../../shared/infrastructure/prisma.service';
import { NightlyReconciliationService } from '../reconciliation/application/nightly-reconciliation.service';
import { CronGuard } from './cron.guard';

/** docs/portal-events.md B4 */
export const PORTAL_EVENT_RETENTION_DAYS = 90;

@Controller('cron')
@UseGuards(CronGuard)
export class CronController {
  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly expire: ExpirePaymentsUseCase,
    private readonly prisma: PrismaService,
    private readonly reconciliation: NightlyReconciliationService,
  ) {}

  @Get('outbox')
  async outbox() {
    // A few batches per invocation; stays well within the function timeout.
    const total = { claimed: 0, sent: 0, retried: 0, dead: 0 };
    for (let i = 0; i < 5; i++) {
      const s = await this.dispatcher.sweep(50);
      for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += s[k];
      if (s.claimed < 50) break;
    }
    return total;
  }

  /**
   * Nightly: compare yesterday (UTC) with Monime, then the housekeeping the
   * 5-minute crons do — on plans that only allow daily crons this is the
   * fallback (Supabase pg_cron also expires payments every 5 minutes).
   */
  @Get('reconcile')
  async reconcile() {
    const reconciliation = await this.reconciliation.runNightly();
    const housekeeping = await this.expirePayments();
    const outbox = await this.outbox();
    return { ...reconciliation, housekeeping, outbox };
  }

  /**
   * Open payments past expiry (Monime never called back) → EXPIRED; old USSD sessions
   * removed; portal events older than 90 days purged (they hold names and phones).
   */
  @Get('expire-payments')
  async expirePayments() {
    const expired = await this.expire.execute();
    const { count: ussdSessions } = await this.prisma.ussdSession.deleteMany({ where: { updatedAt: { lt: new Date(Date.now() - 24 * 60 * 60_000) } } });
    const { count: portalEvents } = await this.prisma.portalEvent.deleteMany({ where: { receivedAt: { lt: new Date(Date.now() - PORTAL_EVENT_RETENTION_DAYS * 24 * 60 * 60_000) } } });
    return { expired, ussdSessionsDeleted: ussdSessions, portalEventsDeleted: portalEvents };
  }
}
