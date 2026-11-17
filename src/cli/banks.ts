/** pnpm monime:banks [country] — bank provider ids usable for payouts. */
import { MONIME_CLIENT, type MonimeClient } from '../modules/integrations/monime/monime.port';
import { withApp } from './context';

void withApp(async (app) => {
  const country = process.argv[2] ?? 'SL';
  console.table(await app.get<MonimeClient>(MONIME_CLIENT).listBanks(country));
});
