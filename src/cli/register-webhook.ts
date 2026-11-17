/**
 * pnpm monime:register-webhook https://<your-domain>/webhooks/monime
 * Registers our endpoint with Monime (HS256, secret = MONIME_WEBHOOK_SECRET) for
 * every event we handle. Monime requires an HTTPS URL on a domain name.
 */
import { createHash } from 'node:crypto';
import { AppConfig } from '../config/app-config';
import { MONIME_CLIENT, type MonimeClient } from '../modules/integrations/monime/monime.port';
import { SUBSCRIBED_EVENTS } from '../modules/webhooks/domain/monime-webhook';
import { withApp } from './context';

void withApp(async (app) => {
  const url = process.argv[2];
  if (!url || !/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(url)) {
    throw new Error('Usage: pnpm monime:register-webhook https://<domain>/webhooks/monime (HTTPS domain required by Monime)');
  }
  const secret = app.get(AppConfig).get('MONIME_WEBHOOK_SECRET');
  const key = `webhook-${createHash('sha256').update(url).digest('hex').slice(0, 40)}`;
  const res = await app.get<MonimeClient>(MONIME_CLIENT).createWebhook({ idempotencyKey: key, name: 'UNIMAK fees', url, events: SUBSCRIBED_EVENTS, secret });
  console.log(`✓ Webhook ${res.id} → ${url}\n  events: ${SUBSCRIBED_EVENTS.join(', ')}`);
});
