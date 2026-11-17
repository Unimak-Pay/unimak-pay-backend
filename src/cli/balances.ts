/** pnpm monime:balances — refresh and print available balances of our accounts. */
import { MONIME_CLIENT, type MonimeClient } from '../modules/integrations/monime/monime.port';
import { PrismaService } from '../shared/infrastructure/prisma.service';
import { sle, withApp } from './context';

void withApp(async (app) => {
  const prisma = app.get(PrismaService);
  const monime = app.get<MonimeClient>(MONIME_CLIENT);
  const rows = [];
  for (const a of await prisma.financialAccount.findMany({ orderBy: { reference: 'asc' } })) {
    const remote = await monime.getFinancialAccount(a.monimeId, { withBalance: true });
    await prisma.financialAccount.update({ where: { id: a.id }, data: { availableBalance: remote.available, balanceUpdatedAt: new Date() } });
    const reserved = await prisma.payout.aggregate({ where: { financialAccountId: a.id, status: 'REQUESTED' }, _sum: { amount: true } });
    rows.push({ reference: a.reference, monimeId: a.monimeId, available: sle(remote.available), unsubmittedPayouts: sle(reserved._sum.amount ?? 0n) });
  }
  console.table(rows);
});
