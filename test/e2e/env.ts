import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_CLIENT, TEST_CRON_SECRET, TEST_WEBHOOK_SECRET } from './test-env';

const TEST_DATABASE_URL = process.env.E2E_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('E2E_DATABASE_URL not set (global setup did not run?)');

// Each test file gets its own copy of the portal fixtures (notifyPayment writes to it).
const fixtures = mkdtempSync(path.join(os.tmpdir(), 'unimak-portal-'));
cpSync(path.resolve(__dirname, '../../fixtures/portal'), fixtures, { recursive: true });
writeFileSync(path.join(fixtures, 'notifications.log.json'), '[]');

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DATABASE_URL,
  DIRECT_URL: TEST_DATABASE_URL,
  PUBLIC_BASE_URL: 'http://receipts.test',
  PORTAL_MODE: 'mock',
  PORTAL_MOCK_LATENCY_MS: '0',
  PORTAL_FIXTURES_DIR: fixtures,
  MONIME_MODE: 'mock',
  MONIME_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
  PLATFORM_MONIME_ACCOUNT: 'fa-platform-commission',
  CHANNEL_CLIENTS: JSON.stringify([TEST_CLIENT]),
  CRON_SECRET: TEST_CRON_SECRET,
  PAYMENT_EXPIRY_MINUTES: '15',
  OUTBOX_DISPATCH_INLINE: 'true',
});
delete process.env.MONIME_WEBHOOK_TOLERANCE_SECONDS;
