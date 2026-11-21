import { BadRequestException, Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApplyPortalEventsUseCase, type RawPortalEvent } from '../../payers/application/apply-portal-events.use-case';
import { MAX_EVENTS_PER_BATCH, PORTAL_EVENT_ID } from '../../payers/domain/portal-event';
import { RosterSummaryQuery } from '../application/roster-summary.query';
import { PortalSignatureGuard } from './portal-signature.guard';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Called by the university portal (docs/portal-events.md). */
@Controller('v1/portal')
@UseGuards(PortalSignatureGuard)
export class PortalEventsController {
  constructor(
    private readonly apply: ApplyPortalEventsUseCase,
    private readonly summary: RosterSummaryQuery,
  ) {}

  /**
   * A batch of 1-500 events. 200 with a result per event, in order. Only the envelope
   * is checked here (400 for the whole batch); each record is validated on its own.
   */
  @Post('events')
  @HttpCode(200)
  async events(@Body() body: unknown) {
    const events = isObj(body) ? body['events'] : undefined;
    if (!Array.isArray(events) || events.length < 1 || events.length > MAX_EVENTS_PER_BATCH) {
      throw new BadRequestException(`Body must be { "events": [...] } with 1-${MAX_EVENTS_PER_BATCH} events`);
    }
    const seen = new Set<string>();
    events.forEach((e, i) => {
      if (!isObj(e) || typeof e['id'] !== 'string' || !PORTAL_EVENT_ID.test(e['id'])) {
        throw new BadRequestException(`events[${i}].id must be 1-100 letters, digits or _ . : -`);
      }
      if (seen.has(e['id'])) throw new BadRequestException(`events[${i}].id ${e['id']} appears twice in this batch`);
      seen.add(e['id']);
    });
    return { results: await this.apply.execute(events as RawPortalEvent[]) };
  }

  @Get('summary')
  getSummary() {
    return this.summary.execute();
  }
}
