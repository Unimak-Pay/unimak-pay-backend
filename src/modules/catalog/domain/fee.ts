import type { Minor } from '../../../shared/domain/money';
import type { EligibilityRule } from './eligibility';
import type { PayerKind } from './payer-profile';
import type { RateRule } from './rate-rule';

export type Recurrence = 'ONCE' | 'PER_YEAR';
export type FeeStatus = 'DRAFT' | 'ACTIVE' | 'CLOSED';

export interface FeeTypeInfo {
  id: string;
  code: string;
  name: string;
  payerKind: PayerKind;
  recurrence: Recurrence;
  settlementAccount: string;
}

/** A fee with everything needed to decide who owes it and how much. */
export interface FeeWithRules {
  id: string;
  name: string;
  period: string;
  allowInstalments: boolean;
  defaultMinInstalment: Minor | null;
  dueDate: Date | null;
  status: FeeStatus;
  feeType: FeeTypeInfo;
  rateRules: RateRule[];
  eligibilityRules: EligibilityRule[];
}

export const APPLICATION_FEE_CODE = 'APP';
