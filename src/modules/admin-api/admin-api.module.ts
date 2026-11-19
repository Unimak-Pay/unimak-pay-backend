import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CatalogModule } from '../catalog/catalog.module';
import { PayersModule } from '../payers/payers.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PaymentsModule } from '../payments/payments.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { AdminCatalogService } from './application/admin-catalog.service';
import { AdminReportsService } from './application/admin-reports.service';
import { AdminOpsService } from './application/admin-ops.service';
import { AdminUsersService } from './application/admin-users.service';
import { AdminCatalogController } from './interface/admin-catalog.controller';
import { AdminController } from './interface/admin.controller';

/** /v1/admin: Supabase Auth JWT + permission guard, audited writes. */
@Module({
  imports: [AuthModule, PaymentsModule, TreasuryModule, OutboxModule, WebhooksModule, ReconciliationModule, CatalogModule, PayersModule],
  controllers: [AdminController, AdminCatalogController],
  providers: [AdminOpsService, AdminUsersService, AdminCatalogService, AdminReportsService],
})
export class AdminApiModule {}
