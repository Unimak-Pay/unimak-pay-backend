import type { PayerProfile } from '../../catalog/domain/payer-profile';
import { decideReprice, type RepriceInput } from './reprice';

const profile: PayerProfile = { kind: 'STUDENT', programCode: 'BSC-CS', department: 'COMPUTER-SCI', level: 1, residency: 'LOCAL', intake: '2026-SEP', finalYear: false };
const any = { programCode: null, department: null, level: null, residency: null, intake: null };
const rules = {
  rateRules: [
    { ...any, id: 'general', amount: 600_000n },
    { ...any, id: 'cs-l1', programCode: 'BSC-CS', level: 1, amount: 10_000n },
  ],
  eligibilityRules: [],
};
const now = new Date('2026-11-20T12:00:00Z');
const base: RepriceInput = { status: 'OPEN', amount: 600_000n, entryTypes: ['CHARGE'], openPayments: [], profile };

describe('decideReprice', () => {
  it('moves an untouched obligation to the best current rule', () => {
    expect(decideReprice(base, rules, now)).toEqual({ kind: 'CHANGE', proposed: 10_000n, difference: -590_000n, rateRuleId: 'cs-l1' });
    expect(decideReprice({ ...base, amount: 5_000n }, rules, now)).toMatchObject({ kind: 'CHANGE', difference: 5_000n });
  });

  it('leaves it when the price is the same', () => {
    expect(decideReprice({ ...base, amount: 10_000n, entryTypes: ['CHARGE', 'ADJUSTMENT'] }, rules, now)).toEqual({ kind: 'UNCHANGED' });
  });

  it('never touches paid or part-paid obligations, or ones with a payment in progress', () => {
    expect(decideReprice({ ...base, status: 'PAID' }, rules, now)).toEqual({ kind: 'SKIP', reason: 'PAID' });
    expect(decideReprice({ ...base, entryTypes: ['CHARGE', 'PAYMENT'] }, rules, now)).toEqual({ kind: 'SKIP', reason: 'HAS_PAYMENTS' });
    expect(decideReprice({ ...base, entryTypes: ['CHARGE', 'PAYMENT', 'REFUND'] }, rules, now)).toEqual({ kind: 'SKIP', reason: 'HAS_PAYMENTS' });
    const live = { status: 'PENDING', expiresAt: new Date(now.getTime() + 60_000) };
    expect(decideReprice({ ...base, openPayments: [live] }, rules, now)).toEqual({ kind: 'SKIP', reason: 'PAYMENT_IN_PROGRESS' });
    // a hold past its expiry no longer blocks
    expect(decideReprice({ ...base, openPayments: [{ ...live, expiresAt: new Date(now.getTime() - 1) }] }, rules, now)).toMatchObject({ kind: 'CHANGE' });
  });

  it('reports payers it can no longer price instead of cancelling them', () => {
    expect(decideReprice(base, { ...rules, eligibilityRules: [{ ...any, programCode: 'BSC-NUR', finalYear: null }] }, now)).toEqual({ kind: 'SKIP', reason: 'NOT_ELIGIBLE' });
    expect(decideReprice(base, { ...rules, rateRules: [{ ...any, id: 'nur', programCode: 'BSC-NUR', amount: 1n }] }, now)).toEqual({ kind: 'SKIP', reason: 'NO_RATE_RULE' });
    const tie = [{ ...any, id: 'a', programCode: 'BSC-CS', amount: 1n }, { ...any, id: 'b', level: 1, amount: 2n }];
    expect(decideReprice(base, { ...rules, rateRules: tie }, now)).toEqual({ kind: 'SKIP', reason: 'AMBIGUOUS_RATE_RULE' });
  });
});
