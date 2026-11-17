/**
 * pnpm monime:payout --account unimak-fee-tuition --amount 150000 --bank slb001 \
 *   --account-number 0123456789 [--name "University of Makeni"] [--narration "..."] \
 *   [--key <idempotency key>] [--confirm]
 *
 * Amount is in minor units (150000 = SLE 1,500.00). Without --confirm this is a
 * dry run. Re-running with the same --key never pays twice.
 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { RequestPayoutUseCase } from '../modules/treasury/application/request-payout.use-case';
import { PAYOUTS_MANAGE } from '../modules/treasury/domain/payout-policy';
import { sle, withApp } from './context';

const { values: a } = parseArgs({
  options: {
    account: { type: 'string' },
    amount: { type: 'string' },
    bank: { type: 'string' },
    'account-number': { type: 'string' },
    name: { type: 'string' },
    narration: { type: 'string' },
    key: { type: 'string' },
    confirm: { type: 'boolean', default: false },
  },
});

void withApp(async (app) => {
  if (!a.account || !a.amount || !/^[1-9]\d*$/.test(a.amount) || !a.bank || !a['account-number']) {
    throw new Error('Required: --account --amount (minor units) --bank --account-number');
  }
  const input = {
    account: a.account,
    amount: BigInt(a.amount),
    bankProviderId: a.bank,
    accountNumber: a['account-number'],
    accountName: a.name,
    narration: a.narration,
    idempotencyKey: a.key ?? `cli-${randomUUID()}`,
  };
  console.log(`Payout ${sle(input.amount)} from ${input.account} → ${input.bankProviderId} ${input.accountNumber}${input.accountName ? ` (${input.accountName})` : ''}`);
  if (!a.confirm) {
    console.log('Dry run. Re-run with --confirm to send it.');
    return;
  }
  const actor = { id: `cli:${os.userInfo().username}`, permissions: [PAYOUTS_MANAGE] };
  const p = await app.get(RequestPayoutUseCase).execute(actor, input);
  console.log(`✓ Payout ${p.id} ${p.status}${p.monimePayoutId ? ` (Monime ${p.monimePayoutId})` : ''}; key ${input.idempotencyKey}`);
});
