/** Shared by global setup/teardown and each test file. */

/** Connection used only to CREATE/DROP the per-run database (local docker by default). */
export const TEST_ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://unimak:unimak@localhost:54329/unimak';

export function testDatabaseUrl(name: string): string {
  const u = new URL(TEST_ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

export const TEST_WEBHOOK_SECRET = 'e2e-webhook-secret-0123456789abcdef0123';
export const TEST_CLIENT = { id: 'ussd', apiKey: 'e2e-ussd-key', secret: 'e2e-ussd-secret-0123456789' };
export const TEST_CRON_SECRET = 'e2e-cron-secret-0123456789';
