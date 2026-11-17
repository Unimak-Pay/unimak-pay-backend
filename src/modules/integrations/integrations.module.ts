import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../shared/infrastructure/prisma.service';
import { HttpMonimeClient } from './monime/http-monime.client';
import { MockMonimeClient } from './monime/mock-monime.client';
import { MONIME_CLIENT } from './monime/monime.port';
import { HttpPortalClient } from './portal/http-portal.client';
import { MockPortalClient } from './portal/mock-portal.client';
import { PORTAL_CLIENT } from './portal/portal.port';
import { ConsoleSmsSender } from './sms/console-sms.sender';
import { SMS_SENDER } from './sms/sms.port';

@Global()
@Module({
  providers: [
    {
      provide: PORTAL_CLIENT,
      inject: [AppConfig],
      useFactory: (cfg: AppConfig) =>
        cfg.get('PORTAL_MODE') === 'http'
          ? new HttpPortalClient(cfg.get('PORTAL_BASE_URL')!, cfg.get('PORTAL_API_KEY'))
          : new MockPortalClient(cfg.get('PORTAL_FIXTURES_DIR'), cfg.get('PORTAL_MOCK_LATENCY_MS')),
    },
    {
      provide: MONIME_CLIENT,
      inject: [AppConfig, PrismaService],
      useFactory: (cfg: AppConfig, prisma: PrismaService) =>
        cfg.get('MONIME_MODE') === 'http'
          ? new HttpMonimeClient({
              baseUrl: cfg.get('MONIME_BASE_URL'),
              accessToken: cfg.get('MONIME_ACCESS_TOKEN')!,
              spaceId: cfg.get('MONIME_SPACE_ID')!,
              apiVersion: cfg.get('MONIME_API_VERSION'),
            })
          : new MockMonimeClient(prisma),
    },
    // TODO: real SMS provider adapter; console sender in all environments for now.
    { provide: SMS_SENDER, useValue: new ConsoleSmsSender() },
  ],
  exports: [PORTAL_CLIENT, MONIME_CLIENT, SMS_SENDER],
})
export class IntegrationsModule {}
