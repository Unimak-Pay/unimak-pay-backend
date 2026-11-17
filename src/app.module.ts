import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { HealthController } from './health.controller';
import { CatalogModule } from './modules/catalog/catalog.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { PrismaModule } from './shared/infrastructure/prisma.module';

@Module({
  imports: [AppConfigModule, PrismaModule, IntegrationsModule, CatalogModule],
  controllers: [HealthController],
})
export class AppModule {}
