/**
 * pnpm ussd:flow https://<your-domain>  > unimak-flow.json
 * Renders ussd/unimak-flow.template.json with the exchange URL
 * (<domain>/v1/ussd/exchange/<USSD_EXCHANGE_PATH_TOKEN>) for import into the
 * Monime dashboard. The output contains the secret token: don't commit it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const base = process.argv[2];
const token = process.env.USSD_EXCHANGE_PATH_TOKEN;
if (!base || !/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(base.replace(/\/+$/, ''))) {
  console.error('Usage: pnpm ussd:flow https://<domain>   (HTTPS domain, no path)');
  process.exit(1);
}
if (!token || token.length < 32) {
  console.error('Set USSD_EXCHANGE_PATH_TOKEN (≥ 32 chars), e.g. openssl rand -hex 32');
  process.exit(1);
}
const template = readFileSync(path.resolve(__dirname, '../../../ussd/unimak-flow.template.json'), 'utf8');
process.stdout.write(template.replaceAll('{{EXCHANGE_URL}}', `${base.replace(/\/+$/, '')}/v1/ussd/exchange/${token}`));
