import { Module } from '@nestjs/common';
import { CommissionTransferService } from './application/commission-transfer.service';
import { PlatformAccount } from './application/platform-account';
import { ProvisionAccountsUseCase } from './application/provision-accounts.use-case';
import { RequestPayoutUseCase } from './application/request-payout.use-case';
import { TreasuryEventsService } from './application/treasury-events.service';

/** Monime financial accounts, commission transfers and payouts. */
@Module({
  providers: [PlatformAccount, ProvisionAccountsUseCase, CommissionTransferService, RequestPayoutUseCase, TreasuryEventsService],
  exports: [PlatformAccount, ProvisionAccountsUseCase, CommissionTransferService, RequestPayoutUseCase, TreasuryEventsService],
})
export class TreasuryModule {}
