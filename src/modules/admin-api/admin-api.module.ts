import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PaymentsModule } from '../payments/payments.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { AdminOpsService } from './application/admin-ops.service';
import { AdminUsersService } from './application/admin-users.service';
import { AdminController } from './interface/admin.controller';

/** /v1/admin: Supabase Auth JWT + permission guard, audited writes. */
@Module({
  imports: [AuthModule, PaymentsModule, TreasuryModule, OutboxModule, WebhooksModule],
  controllers: [AdminController],
  providers: [AdminOpsService, AdminUsersService],
})
export class AdminApiModule {}
