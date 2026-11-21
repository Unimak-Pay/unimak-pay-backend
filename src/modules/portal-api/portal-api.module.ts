import { Module } from '@nestjs/common';
import { PayersModule } from '../payers/payers.module';
import { RosterSummaryQuery } from './application/roster-summary.query';
import { PortalEventsController } from './interface/portal-events.controller';
import { PortalSignatureGuard } from './interface/portal-signature.guard';

/** Inbound from the university portal: roster events and the count check. */
@Module({
  imports: [PayersModule],
  controllers: [PortalEventsController],
  providers: [PortalSignatureGuard, RosterSummaryQuery],
})
export class PortalApiModule {}
