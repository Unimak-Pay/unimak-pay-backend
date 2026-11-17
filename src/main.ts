import { createApp } from './bootstrap';
import { AppConfig } from './config/app-config';

async function main(): Promise<void> {
  const app = await createApp();
  const port = app.get(AppConfig).get('PORT');
  await app.listen(port);
  console.log(`UNIMAK fees API listening on :${port}`);
}

void main();
