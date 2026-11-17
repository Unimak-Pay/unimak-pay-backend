import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';

/** Boots the app without HTTP, runs `fn`, always closes. */
export async function withApp(fn: (app: INestApplicationContext) => Promise<void>): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    await fn(app);
  } catch (err) {
    console.error(`\n✗ ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

export const sle = (minor: bigint | null | undefined) =>
  minor === null || minor === undefined ? '—' : `SLE ${(Number(minor) / 100).toLocaleString('en', { minimumFractionDigits: 2 })}`;
