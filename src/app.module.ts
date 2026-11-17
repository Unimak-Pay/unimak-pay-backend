import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { HealthController } from './health.controller';
import { PrismaModule } from './shared/infrastructure/prisma.module';

@Module({
  imports: [AppConfigModule, PrismaModule],
  controllers: [HealthController],
})
export class AppModule {}
