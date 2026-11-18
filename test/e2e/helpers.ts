import { createHmac } from 'node:crypto';
import type request from 'supertest';
import { signMonimePayload } from '../../src/modules/webhooks/domain/monime-signature';
import { TEST_CLIENT, TEST_WEBHOOK_SECRET } from './test-env';

type Http = ReturnType<typeof request>;

/** Signed channel-API request. */
export function channel(http: Http, method: 'get' | 'post', url: string, body?: object) {
  const raw = body ? JSON.stringify(body) : '';
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac('sha256', TEST_CLIENT.secret).update(`${ts}.${raw}`).digest('hex');
  let req = http[method](url).set('x-api-key', TEST_CLIENT.apiKey).set('x-timestamp', ts).set('x-signature', sig);
  if (body) req = req.set('content-type', 'application/json').send(raw);
  return req;
}

/** Delivers a raw Monime event, signed as Monime would. */
export function monimeEvent(http: Http, name: string, object: Record<string, unknown>, data: Record<string, unknown>, eventId = `wke-e2e-${Math.random().toString(36).slice(2)}`) {
  const raw = JSON.stringify({ apiVersion: 'caph.2025-08-23', event: { id: eventId, name, timestamp: String(Math.floor(Date.now() / 1000)) }, object, data });
  const header = signMonimePayload(raw, TEST_WEBHOOK_SECRET, String(Math.floor(Date.now() / 1000)));
  return http.post('/webhooks/monime').set('content-type', 'application/json').set('Monime-Signature', header).send(raw);
}

/** Supabase-shaped access token signed with the e2e key (see env.ts). */
export function adminToken(c: { sub: string; email?: string; aal?: 'aal1' | 'aal2'; exp?: number; role?: string }): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createPrivateKey, sign } = require('node:crypto') as typeof import('node:crypto');
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'ES256', kid: 'e2e-key', typ: 'JWT' });
  const body = b64({
    iss: 'https://e2e.supabase.test/auth/v1', aud: 'authenticated', role: c.role ?? 'authenticated',
    sub: c.sub, email: c.email, aal: c.aal ?? 'aal1', iat: now, exp: c.exp ?? now + 3600, session_id: 's',
  });
  const key = createPrivateKey(process.env.E2E_JWT_PRIVATE_KEY!);
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
