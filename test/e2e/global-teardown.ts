import { PrismaClient } from '@prisma/client';
import { TEST_ADMIN_URL } from './test-env';

/** Drops only the database this run created (set E2E_KEEP_DB=1 to inspect it). */
export default async function globalTeardown(): Promise<void> {
  const name = process.env.E2E_DATABASE_NAME;
  if (!name?.startsWith('unimak_e2e_') || process.env.E2E_KEEP_DB) return;
  const admin = new PrismaClient({ datasources: { db: { url: TEST_ADMIN_URL } } });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.$disconnect();
  }
}
