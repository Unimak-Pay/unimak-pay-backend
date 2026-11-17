import { DomainError } from '../../../shared/domain/errors';
import { formatSle, type Minor } from '../../../shared/domain/money';
import { APPLICATION_FEE_CODE } from '../../catalog/domain/fee';
import type { ObligationPosition } from '../../ledger/domain/position';

export interface InitiateCheck {
  feeTypeCode: string;
  feeActive: boolean;
  position: ObligationPosition;
  minInstalment: Minor;
  amount: Minor;
}

/** Rules for accepting a new payment against an obligation (run under row lock). */
export function assertCanInitiate(c: InitiateCheck): void {
  if (c.position.balance <= 0n) {
    throw new DomainError(
      'OBLIGATION_SETTLED',
      c.feeTypeCode === APPLICATION_FEE_CODE
        ? 'The application fee has already been paid for this application'
        : 'This fee is already fully paid',
    );
  }
  if (!c.feeActive) throw new DomainError('FEE_NOT_ACTIVE', 'This fee is not open for payment');
  if (c.position.payable <= 0n) {
    throw new DomainError('INVALID_STATE', 'A payment for this fee is already in progress');
  }
  if (c.amount > c.position.payable) {
    throw new DomainError(
      'AMOUNT_EXCEEDS_PAYABLE',
      `Amount exceeds the payable ${formatSle(c.position.payable)}`,
      { payable: c.position.payable.toString() },
    );
  }
  if (c.amount < c.minInstalment) {
    throw new DomainError(
      'AMOUNT_BELOW_MIN_INSTALMENT',
      `Minimum payment is ${formatSle(c.minInstalment)}`,
      { minInstalment: c.minInstalment.toString() },
    );
  }
}
