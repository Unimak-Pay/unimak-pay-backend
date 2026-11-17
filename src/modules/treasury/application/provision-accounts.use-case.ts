import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { MONIME_CLIENT, type MonimeClient } from '../../integrations/monime/monime.port';
import { feeTypeAccountName, feeTypeAccountReference, PLATFORM_ACCOUNT_REFERENCE } from '../domain/accounts';

export interface ProvisionedAccount {
  reference: string;
  monimeId: string;
  name: string;
  purpose: 'FEE_TYPE' | 'PLATFORM';
  feeTypeCode: string | null;
  created: boolean;
}

/**
 * One Monime financial account per fee type (APP, TUITION, …) plus the
 * platform account. Safe to re-run: existing rows are kept, and an account that
 * exists in Monime but not here (e.g. a crash between the two writes) is found
 * by its unique reference instead of being created twice.
 */
@Injectable()
export class ProvisionAccountsUseCase {
  private readonly logger = new Logger(ProvisionAccountsUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MONIME_CLIENT) private readonly monime: MonimeClient,
  ) {}

  async execute(opts: { platform?: boolean } = {}): Promise<ProvisionedAccount[]> {
    const out: ProvisionedAccount[] = [];
    const feeTypes = await this.prisma.feeType.findMany({ include: { account: true }, orderBy: { code: 'asc' } });
    for (const ft of feeTypes) {
      if (ft.account) {
        out.push({ reference: ft.account.reference, monimeId: ft.account.monimeId, name: ft.account.name, purpose: 'FEE_TYPE', feeTypeCode: ft.code, created: false });
        continue;
      }
      const reference = feeTypeAccountReference(ft.code);
      const { id, uvan, name, created } = await this.ensureRemote(reference, feeTypeAccountName(ft.name), { feeTypeCode: ft.code });
      await this.prisma.financialAccount.create({ data: { monimeId: id, reference, name, purpose: 'FEE_TYPE', feeTypeId: ft.id, uvan } });
      out.push({ reference, monimeId: id, name, purpose: 'FEE_TYPE', feeTypeCode: ft.code, created });
    }

    if (opts.platform ?? true) {
      const existing = await this.prisma.financialAccount.findUnique({ where: { reference: PLATFORM_ACCOUNT_REFERENCE } });
      if (existing) {
        out.push({ reference: existing.reference, monimeId: existing.monimeId, name: existing.name, purpose: 'PLATFORM', feeTypeCode: null, created: false });
      } else {
        const { id, uvan, name, created } = await this.ensureRemote(PLATFORM_ACCOUNT_REFERENCE, 'Platform commission', { purpose: 'platform' });
        await this.prisma.financialAccount.create({ data: { monimeId: id, reference: PLATFORM_ACCOUNT_REFERENCE, name, purpose: 'PLATFORM', uvan } });
        out.push({ reference: PLATFORM_ACCOUNT_REFERENCE, monimeId: id, name, purpose: 'PLATFORM', feeTypeCode: null, created });
      }
    }
    return out;
  }

  private async ensureRemote(reference: string, name: string, metadata: Record<string, string>) {
    const found = await this.monime.findFinancialAccountByReference(reference);
    if (found) {
      this.logger.log(`Linked existing Monime account ${found.id} (${reference})`);
      return { id: found.id, uvan: found.uvan, name: found.name, created: false };
    }
    const fa = await this.monime.createFinancialAccount({
      idempotencyKey: `provision-${reference}`.slice(0, 64),
      name,
      currency: 'SLE',
      reference,
      description: `UNIMAK fee collection — ${reference}`,
      metadata: { system: 'unimak-fees', ...metadata },
    });
    this.logger.log(`Created Monime account ${fa.id} (${reference})`);
    return { id: fa.id, uvan: fa.uvan, name: fa.name, created: true };
  }
}
