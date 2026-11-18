import { type DynamicModule, Module, type Type } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppConfigModule } from './config/config.module';
import { HealthController } from './health.controller';
import { AdminApiModule } from './modules/admin-api/admin-api.module';
import { AuditModule } from './modules/audit/audit.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { ChannelApiModule } from './modules/channel-api/channel-api.module';
import { CronModule } from './modules/cron/cron.module';
import { DevModule } from './modules/dev/dev.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { UssdModule } from './modules/ussd/ussd.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { PrismaModule } from './shared/infrastructure/prisma.module';
import { DomainErrorFilter } from './shared/interface/domain-error.filter';

/** Dev routes (/dev/*) exist only outside production — not just disabled. */
function devModules(): (Type | DynamicModule)[] {
  return process.env.NODE_ENV === 'production' ? [] : [DevModule];
}

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    AuditModule,
    IntegrationsModule,
    CatalogModule,
    ChannelApiModule,
    WebhooksModule,
    UssdModule,
    CronModule,
    AdminApiModule,
    ...devModules(),
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: DomainErrorFilter }],
})
export class AppModule {}
