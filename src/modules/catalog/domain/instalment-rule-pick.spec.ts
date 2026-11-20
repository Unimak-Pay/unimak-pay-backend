import { pickInstalmentRule } from './instalments';

const rules = [
  { department: 'COMPUTER-SCI', level: null, minInstalment: 150_000n },
  { department: 'COMPUTER-SCI', level: 1, minInstalment: 50_000n },
  { department: 'NURSING', level: 3, minInstalment: 90_000n },
];

describe('pickInstalmentRule', () => {
  it('prefers the payer level, then the department-wide rule', () => {
    expect(pickInstalmentRule(rules, 'COMPUTER-SCI', 1)?.minInstalment).toBe(50_000n);
    expect(pickInstalmentRule(rules, 'COMPUTER-SCI', 2)?.minInstalment).toBe(150_000n);
  });

  it('applicants (no level) only get the department-wide rule', () => {
    expect(pickInstalmentRule(rules, 'COMPUTER-SCI', null)?.minInstalment).toBe(150_000n);
    expect(pickInstalmentRule(rules, 'NURSING', null)).toBeNull();
  });

  it('nothing for another department, another level without a fallback, or no department', () => {
    expect(pickInstalmentRule(rules, 'NURSING', 2)).toBeNull();
    expect(pickInstalmentRule(rules, 'LAW', 1)).toBeNull();
    expect(pickInstalmentRule(rules, null, 1)).toBeNull();
  });
});
