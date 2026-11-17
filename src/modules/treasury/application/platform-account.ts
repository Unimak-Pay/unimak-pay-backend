import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';

/** Where commission goes: the provisioned PLATFORM account, else PLATFORM_MONIME_ACCOUNT. */
@Injectable()
export class PlatformAccount {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  async monimeId(): Promise<string | null> {
    const row = await this.prisma.financialAccount.findFirst({ where: { purpose: 'PLATFORM' }, orderBy: { createdAt: 'asc' } });
    return row?.monimeId ?? this.config.get('PLATFORM_MONIME_ACCOUNT') ?? null;
  }
}
