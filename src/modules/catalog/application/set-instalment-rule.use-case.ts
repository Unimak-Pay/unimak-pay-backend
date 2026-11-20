import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../../shared/domain/errors';
import type { Minor } from '../../../shared/domain/money';
import { assertCanManageInstalments } from '../domain/instalments';
import { CATALOG_REPOSITORY, type CatalogRepository } from './catalog.repository';

export interface Actor {
  id: string;
  permissions: readonly string[];
}

@Injectable()
export class SetInstalmentRuleUseCase {
  constructor(@Inject(CATALOG_REPOSITORY) private readonly catalog: CatalogRepository) {}

  async execute(
    actor: Actor,
    input: { feeId: string; department: string; level: number | null; minInstalment: Minor },
  ): Promise<void> {
    assertCanManageInstalments(actor.permissions);
    if (input.minInstalment <= 0n) throw new DomainError('VALIDATION', 'Must be positive');
    if (input.level !== null && (!Number.isInteger(input.level) || input.level < 1 || input.level > 10)) {
      throw new DomainError('VALIDATION', 'level must be a whole number from 1 to 10');
    }
    const fee = await this.catalog.feeById(input.feeId);
    if (!fee) throw new DomainError('NOT_FOUND', 'Fee not found');
    if (!fee.allowInstalments) {
      throw new DomainError('INSTALMENTS_NOT_ALLOWED', 'Fee does not allow instalments');
    }
    await this.catalog.upsertInstalmentRule(
      input.feeId,
      input.department,
      input.level,
      input.minInstalment,
      actor.id,
    );
  }
}
