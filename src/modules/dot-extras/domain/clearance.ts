import { generateVerifyCode, isVerifyCodeShape } from '../../receipts/domain/receipt';

/**
 * Exam clearance (docs/dot-extras.md §4). The rule belongs to the finance office and is
 * edited in the admin API. Until they give the real one, the stored rule is a
 * placeholder of this shape: every fee whose type is listed (in the exam's period),
 * plus, if includeOverdue, any fee past its due date, must have a zero balance.
 */
export interface ClearanceRule {
  examName: string;
  period: string;
  feeTypeCodes: readonly string[];
  includeOverdue: boolean;
}

export interface ClearanceObligation {
  id: string;
  feeName: string;
  feeTypeCode: string;
  period: string;
  dueDate: Date | null;
  /** ledger balance; money still held by an open payment doesn't count as paid */
  balance: bigint;
}

export interface ClearanceResult {
  cleared: boolean;
  outstanding: bigint;
  blocking: { obligationId: string; feeName: string; balance: bigint }[];
}

const DAY = 86_400_000;

/** A fee is past due once its due day (UTC) has ended. */
export const isPastDue = (dueDate: Date | null, now: Date) => !!dueDate && now.getTime() >= dueDate.getTime() + DAY;

export function evaluateClearance(rule: ClearanceRule, obligations: readonly ClearanceObligation[], now: Date): ClearanceResult {
  const blocking = obligations
    .filter((o) => o.balance > 0n)
    .filter((o) => (rule.feeTypeCodes.includes(o.feeTypeCode) && o.period === rule.period) || (rule.includeOverdue && isPastDue(o.dueDate, now)))
    .map((o) => ({ obligationId: o.id, feeName: o.feeName, balance: o.balance }));
  return { cleared: blocking.length === 0, outstanding: blocking.reduce((s, b) => s + b.balance, 0n), blocking };
}

export const PASS_CODE_LENGTH = 8;
export const newPassCode = (): string => generateVerifyCode(PASS_CODE_LENGTH);
export const isPassCode = (s: string): boolean => s.length === PASS_CODE_LENGTH && isVerifyCodeShape(s);
