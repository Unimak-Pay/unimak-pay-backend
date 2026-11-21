/**
 * Signed portal-event requests for local testing (docs/portal-events.md).
 *   pnpm portal:event POST /v1/portal/events '{"events":[…]}'
 *   pnpm portal:event POST /v1/portal/events @batch.json
 *   pnpm portal:event GET  /v1/portal/summary
 * Signs with PORTAL_EVENTS_SECRET; API_URL defaults to http://localhost:$PORT.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [method = 'GET', path = '/v1/portal/summary', arg = ''] = process.argv.slice(2);
const body = arg.startsWith('@') ? readFileSync(arg.slice(1), 'utf8') : arg;
const base = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const secret = process.env.PORTAL_EVENTS_SECRET;
if (!secret) throw new Error('PORTAL_EVENTS_SECRET is not set (load .env first)');

const ts = Math.floor(Date.now() / 1000).toString();
const signature = `v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;

void (async () => {
  const res = await fetch(base + path, {
    method,
    headers: { 'x-portal-timestamp': ts, 'x-portal-signature': signature, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body || undefined,
  });
  const text = await res.text();
  console.log(res.status);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
})();
