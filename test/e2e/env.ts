import { generateKeyPairSync } from 'node:crypto';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_CLIENT, TEST_CRON_SECRET, TEST_PORTAL_SECRET, TEST_PORTAL_SECRET_OLD, TEST_WEBHOOK_SECRET } from './test-env';

const TEST_DATABASE_URL = process.env.E2E_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('E2E_DATABASE_URL not set (global setup did not run?)');

// Each test file gets its own copy of the portal fixtures (notifyPayment writes to it).
const fixtures = mkdtempSync(path.join(os.tmpdir(), 'unimak-portal-'));
cpSync(path.resolve(__dirname, '../../fixtures/portal'), fixtures, { recursive: true });
writeFileSync(path.join(fixtures, 'notifications.log.json'), '[]');

// Stand-in for Supabase Auth's signing key: tests sign tokens, the app reads the JWKS.
const jwt = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...jwt.publicKey.export({ format: 'jwk' }), kid: 'e2e-key', alg: 'ES256', use: 'sig' };

// Our USSD flow key pairs (current + previous, for rotation) and the secret path token.
const ussdKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ussdPrev = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = (k: import('node:crypto').KeyObject, type: 'pkcs8' | 'spki') => k.export({ format: 'pem', type }).toString();

Object.assign(process.env, {
  USSD_RSA_PRIVATE_KEY: pem(ussdKey.privateKey, 'pkcs8').replace(/\n/g, '\\n'), // as stored in an env var
  USSD_RSA_PRIVATE_KEY_PREVIOUS: pem(ussdPrev.privateKey, 'pkcs8'),
  E2E_USSD_PUBLIC_KEY: pem(ussdKey.publicKey, 'spki'),
  E2E_USSD_PREVIOUS_PUBLIC_KEY: pem(ussdPrev.publicKey, 'spki'),
  USSD_EXCHANGE_PATH_TOKEN: 'e2e-ussd-path-token-0123456789abcdef',
  USSD_ALLOW_PLAINTEXT: 'false',
  USSD_MAX_LOOKUPS_PER_15_MIN: '10',
  AUTH_JWKS_JSON: JSON.stringify({ keys: [jwk] }),
  AUTH_JWT_ISSUER: 'https://e2e.supabase.test/auth/v1',
  E2E_JWT_PRIVATE_KEY: jwt.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  ADMIN_REQUIRE_MFA: 'true',
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DATABASE_URL,
  DIRECT_URL: TEST_DATABASE_URL,
  PUBLIC_BASE_URL: 'http://receipts.test',
  PORTAL_MODE: 'mock',
  PORTAL_MOCK_LATENCY_MS: '0',
  PORTAL_FIXTURES_DIR: fixtures,
  MONIME_MODE: 'mock',
  MONIME_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
  PORTAL_EVENTS_SECRET: TEST_PORTAL_SECRET,
  PORTAL_EVENTS_SECRET_PREVIOUS: TEST_PORTAL_SECRET_OLD,
  PLATFORM_MONIME_ACCOUNT: 'fa-platform-commission',
  CHANNEL_CLIENTS: JSON.stringify([TEST_CLIENT]),
  CRON_SECRET: TEST_CRON_SECRET,
  PAYMENT_EXPIRY_MINUTES: '15',
  OUTBOX_DISPATCH_INLINE: 'true',
});
delete process.env.MONIME_WEBHOOK_TOLERANCE_SECONDS;
