/** pnpm monime:provision — one Monime financial account per fee type + the platform account. */
import os from 'node:os';
import { ProvisionAccountsUseCase } from '../modules/treasury/application/provision-accounts.use-case';
import { withApp } from './context';

void withApp(async (app) => {
  const accounts = await app.get(ProvisionAccountsUseCase).execute({ actorId: `cli:${os.userInfo().username}` });
  console.table(accounts.map((a) => ({ reference: a.reference, monimeId: a.monimeId, purpose: a.purpose, feeType: a.feeTypeCode ?? '', created: a.created })));
});
