import { isEligible } from './eligibility';
import { minInstalment, assertCanManageInstalments } from './instalments';
import type { PayerProfile } from './payer-profile';

const base = { programCode: null, department: null, level: null, residency: null, intake: null, finalYear: null };
const p: PayerProfile = {
  kind: 'STUDENT', programCode: 'LLB', department: 'LAW', level: 4, residency: 'LOCAL', intake: '2023-SEP', finalYear: true,
};

describe('isEligible', () => {
  it('no rules = everyone of the kind', () => expect(isEligible([], p)).toBe(true));
  it('matches finalYear', () => {
    expect(isEligible([{ ...base, finalYear: true }], p)).toBe(true);
    expect(isEligible([{ ...base, finalYear: true }], { ...p, finalYear: false })).toBe(false);
  });
  it('any matching rule suffices', () => {
    expect(isEligible([{ ...base, department: 'COMPUTER-SCI' }, { ...base, level: 4 }], p)).toBe(true);
  });
});

describe('minInstalment', () => {
  const pol = { allowInstalments: true, defaultMinInstalment: 50_000n, ruleMinInstalment: null };
  it('uses the fee default', () => expect(minInstalment(pol, 300_000n)).toBe(50_000n));
  it('rule overrides the default', () =>
    expect(minInstalment({ ...pol, ruleMinInstalment: 100_000n }, 300_000n)).toBe(100_000n));
  it('is the full payable when instalments are off', () =>
    expect(minInstalment({ ...pol, allowInstalments: false }, 300_000n)).toBe(300_000n));
  it('is capped at payable so the remainder can be cleared', () =>
    expect(minInstalment(pol, 20_000n)).toBe(20_000n));
  it('requires instalments.manage to change rules', () => {
    expect(() => assertCanManageInstalments(['fees.read'])).toThrow(/instalments.manage/);
    expect(() => assertCanManageInstalments(['instalments.manage'])).not.toThrow();
  });
});
