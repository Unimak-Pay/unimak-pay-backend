import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { TEST_ADMIN_URL, testDatabaseUrl } from './test-env';

/**
 * Creates a brand-new database for this run (unimak_e2e_<timestamp>), applies
 * migrations (non-destructive `migrate deploy`) and seeds it. Nothing existing
 * is reset or dropped; teardown drops only the database created here.
 */
export default async function globalSetup(): Promise<void> {
  const host = new URL(TEST_ADMIN_URL).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host) && !process.env.TEST_DATABASE_ADMIN_URL) {
    throw new Error(`Refusing to create e2e databases on non-local host ${host}`);
  }
  const name = `unimak_e2e_${Date.now()}`;
  const admin = new PrismaClient({ datasources: { db: { url: TEST_ADMIN_URL } } });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.$disconnect();
  }
  const url = testDatabaseUrl(name);
  process.env.E2E_DATABASE_NAME = name;
  process.env.E2E_DATABASE_URL = url;

  const env = { ...process.env, DATABASE_URL: url, DIRECT_URL: url };
  execSync('pnpm -s prisma migrate deploy', { env, stdio: 'pipe' });
  execSync('pnpm -s tsx prisma/seed.ts', { env, stdio: 'pipe' });
}
