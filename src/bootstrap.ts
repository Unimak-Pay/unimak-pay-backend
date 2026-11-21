import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

/** Shared by local `main.ts`, the Vercel handler and e2e tests. */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true, // needed for HMAC (channel API) and webhook signature checks
    bufferLogs: false,
  });
  configureApp(app);
  await app.init();
  return app;
}

export function configureApp(app: INestApplication): void {
  // 1 MB: room for a 500-event portal batch (docs/portal-events.md); Express's default is 100 KB.
  (app as NestExpressApplication).useBodyParser('json', { limit: '1mb' });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableShutdownHooks();
}
