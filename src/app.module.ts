import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppConfigModule } from './config/config.module';
import { HealthController } from './health.controller';
import { AdminApiModule } from './modules/admin-api/admin-api.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { ChannelApiModule } from './modules/channel-api/channel-api.module';
import { CronModule } from './modules/cron/cron.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { PrismaModule } from './shared/infrastructure/prisma.module';
import { DomainErrorFilter } from './shared/interface/domain-error.filter';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    IntegrationsModule,
    CatalogModule,
    ChannelApiModule,
    CronModule,
    AdminApiModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: DomainErrorFilter }],
})
export class AppModule {}
