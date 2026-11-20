import type { DomainError } from '../../../shared/domain/errors';
import type { PayerProfile } from './payer-profile';
import { assertRateRulesUnambiguous, findRateRuleConflicts, type RateRule, resolveRate } from './rate-rule';

let n = 0;
const rule = (m: Partial<RateRule>, amount = 1000n): RateRule => ({
  id: m.id ?? `r${++n}`,
  programCode: null,
  department: null,
  level: null,
  residency: null,
  intake: null,
  amount,
  ...m,
});

const student: PayerProfile = {
  kind: 'STUDENT',
  programCode: 'BSC-CS',
  department: 'COMPUTER-SCI',
  level: 2,
  residency: 'LOCAL',
  intake: '2025-SEP',
  finalYear: false,
};

describe('resolveRate (specificity)', () => {
  it('picks the most specific matching rule', () => {
    const rules = [
      rule({ id: 'any' }, 100n),
      rule({ id: 'prog', programCode: 'BSC-CS' }, 200n),
      rule({ id: 'prog-lvl', programCode: 'BSC-CS', level: 2 }, 300n),
      rule({ id: 'prog-lvl-res', programCode: 'BSC-CS', level: 2, residency: 'LOCAL' }, 400n),
    ];
    expect(resolveRate(rules, student)?.id).toBe('prog-lvl-res');
  });

  it('ignores more specific rules that do not match', () => {
    const rules = [
      rule({ id: 'prog', programCode: 'BSC-CS' }),
      rule({ id: 'intl', programCode: 'BSC-CS', residency: 'INTERNATIONAL' }),
    ];
    expect(resolveRate(rules, student)?.id).toBe('prog');
  });

  it('returns null when nothing matches', () => {
    expect(resolveRate([rule({ programCode: 'LLB' })], student)).toBeNull();
  });

  it('a rule on a key the payer lacks (department=null) does not match', () => {
    const applicant = { ...student, kind: 'APPLICANT' as const, department: null, level: null };
    expect(resolveRate([rule({ department: 'COMPUTER-SCI' })], applicant)).toBeNull();
  });

  it('throws on a runtime tie (defence in depth)', () => {
    const rules = [rule({ programCode: 'BSC-CS' }), rule({ level: 2 })];
    expect(() => resolveRate(rules, student)).toThrow(
      expect.objectContaining({ code: 'AMBIGUOUS_RATE_RULE' }) as DomainError,
    );
  });
});

describe('tie rejection on save', () => {
  it('rejects a duplicate matcher set', () => {
    const existing = [rule({ programCode: 'BSC-CS', level: 2 })];
    expect(() =>
      assertRateRulesUnambiguous(existing, rule({ programCode: 'BSC-CS', level: 2 })),
    ).toThrow(/same matchers/);
  });

  it('rejects two equally specific overlapping rules with no tie-breaker', () => {
    const existing = [rule({ programCode: 'BSC-CS' })];
    expect(() => assertRateRulesUnambiguous(existing, rule({ residency: 'LOCAL' }))).toThrow(
      /add a rule for \[programCode=BSC-CS, residency=LOCAL\]/,
    );
  });

  it('accepts the same pair once the tie-breaker (their union) exists', () => {
    const existing = [
      rule({ programCode: 'BSC-CS' }),
      rule({ programCode: 'BSC-CS', residency: 'LOCAL' }),
    ];
    expect(() => assertRateRulesUnambiguous(existing, rule({ residency: 'LOCAL' }))).not.toThrow();
  });

  it('accepts equally specific rules that can never match the same payer', () => {
    const existing = [rule({ programCode: 'BSC-CS', level: 1 })];
    expect(() =>
      assertRateRulesUnambiguous(existing, rule({ programCode: 'BSC-CS', level: 2 })),
    ).not.toThrow();
  });

  it('accepts rules of different specificity', () => {
    const existing = [rule({ programCode: 'BSC-CS' })];
    expect(() =>
      assertRateRulesUnambiguous(existing, rule({ programCode: 'BSC-CS', level: 2 })),
    ).not.toThrow();
  });

  it('updating a rule in place does not conflict with its old self', () => {
    const r = rule({ id: 'x', programCode: 'BSC-CS' });
    expect(() => assertRateRulesUnambiguous([r], { ...r, amount: 5n })).not.toThrow();
  });

  it('a full program × level × residency grid is unambiguous', () => {
    const grid: RateRule[] = [];
    for (const programCode of ['BSC-CS', 'BSC-NUR', 'LLB'])
      for (const level of [1, 2, 3, 4, 5])
        for (const residency of ['LOCAL', 'INTERNATIONAL'] as const)
          grid.push(rule({ programCode, level, residency }));
    expect(findRateRuleConflicts(grid)).toHaveLength(0);
  });
});
