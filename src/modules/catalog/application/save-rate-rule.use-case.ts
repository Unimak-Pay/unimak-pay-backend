import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../../shared/domain/errors';
import type { Minor } from '../../../shared/domain/money';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import type { Matchers } from '../domain/matchers';
import { assertRateRulesUnambiguous } from '../domain/rate-rule';
import { CATALOG_REPOSITORY, type CatalogRepository } from './catalog.repository';

export interface SaveRateRuleInput extends Matchers {
  feeId: string;
  id?: string;
  amount: Minor;
}

@Injectable()
export class SaveRateRuleUseCase {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CATALOG_REPOSITORY) private readonly catalog: CatalogRepository,
  ) {}

  async execute(input: SaveRateRuleInput): Promise<{ id: string }> {
    if (input.amount <= 0n) throw new DomainError('VALIDATION', 'Amount must be positive');
    const { feeId, ...rest } = input;
    const rule = { ...rest, id: input.id ?? randomUUID() };
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.catalog.lockFeeRateRules(feeId, tx);
      assertRateRulesUnambiguous(existing, rule);
      await this.catalog.upsertRateRule(feeId, rule, tx);
      return { id: rule.id };
    });
  }
}
