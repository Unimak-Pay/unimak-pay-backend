/**
 * Signed channel-API requests for local testing.
 *   pnpm channel GET  /v1/channel/payers/student/UNI-2025-0002/obligations
 *   pnpm channel POST /v1/channel/payments '{"obligationId":"…","amount":"150000",…}'
 * Uses the first client in CHANNEL_CLIENTS unless CHANNEL_CLIENT_ID is set.
 */
import { createHmac } from 'node:crypto';

const [method = 'GET', path = '/health', body = ''] = process.argv.slice(2);
const base = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const clients = JSON.parse(process.env.CHANNEL_CLIENTS ?? '[]') as { id: string; apiKey: string; secret: string }[];
const client = clients.find((c) => c.id === process.env.CHANNEL_CLIENT_ID) ?? clients[0];
if (!client) throw new Error('CHANNEL_CLIENTS is empty (load .env first)');

const ts = Math.floor(Date.now() / 1000).toString();
const signature = createHmac('sha256', client.secret).update(`${ts}.${body}`).digest('hex');

void (async () => {
  const res = await fetch(base + path, {
    method,
    headers: {
      'x-api-key': client.apiKey,
      'x-timestamp': ts,
      'x-signature': signature,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
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
