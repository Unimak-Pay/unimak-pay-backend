import type { FeeWithRules } from '../../catalog/domain/fee';
import type { PayerProfile } from '../../catalog/domain/payer-profile';
import { planObligations } from './obligation-planner';

const appType = { id: 't-app', code: 'APP', name: 'Application', payerKind: 'APPLICANT' as const, recurrence: 'ONCE' as const, settlementAccount: 'fa-app' };
const tuitionType = { id: 't-tui', code: 'TUITION', name: 'Tuition', payerKind: 'STUDENT' as const, recurrence: 'PER_YEAR' as const, settlementAccount: 'fa-tui' };
const anyRule = (id: string, amount: bigint) => ({ id, amount, programCode: null, department: null, level: null, residency: null, intake: null });

const fee = (id: string, feeType: FeeWithRules['feeType'], over: Partial<FeeWithRules> = {}): FeeWithRules => ({
  id, name: id, period: '2026-SEP', allowInstalments: false, defaultMinInstalment: null, dueDate: null,
  status: 'ACTIVE', feeType, rateRules: [anyRule(`${id}-r`, 15_000n)], eligibilityRules: [], ...over,
});

const applicant = (status = 'REJECTED'): PayerProfile & { status: string } => ({
  kind: 'APPLICANT', programCode: 'BSC-CS', department: null, level: null, residency: 'LOCAL', intake: '2026-SEP', finalYear: null, status,
});

describe('application fee: once per application ref', () => {
  const app2026 = fee('app-2026', appType);

  it('is owed whatever the admission outcome (even REJECTED)', () => {
    expect(planObligations(applicant('REJECTED'), [app2026], []).create).toEqual([
      { feeId: 'app-2026', amount: 15_000n, rateRuleId: 'app-2026-r' },
    ]);
  });

  it('is not created twice for the same fee', () => {
    expect(planObligations(applicant(), [app2026], [{ feeId: 'app-2026', feeTypeId: 't-app' }]).create).toEqual([]);
  });

  it('is not created again when another APP fee (new period) becomes active', () => {
    const app2027 = fee('app-2027', appType, { period: '2027-SEP' });
    const plan = planObligations(applicant(), [app2026, app2027], [{ feeId: 'app-2026', feeTypeId: 't-app' }]);
    expect(plan.create).toEqual([]);
  });

  it('only one ONCE obligation even if two APP fees are active at first lookup', () => {
    const app2027 = fee('app-2027', appType, { period: '2027-SEP' });
    expect(planObligations(applicant(), [app2026, app2027], []).create).toHaveLength(1);
  });
});

describe('planObligations', () => {
  const student: PayerProfile = { kind: 'STUDENT', programCode: 'BSC-CS', department: 'COMPUTING', level: 2, residency: 'LOCAL', intake: '2025-SEP', finalYear: false };

  it('skips other payer kinds, inactive fees and ineligible payers', () => {
    const fees = [
      fee('app', appType),
      fee('draft', tuitionType, { status: 'DRAFT' }),
      fee('grad', tuitionType, { eligibilityRules: [{ programCode: null, department: null, level: null, residency: null, intake: null, finalYear: true }] }),
      fee('tui', tuitionType),
    ];
    expect(planObligations(student, fees, []).create.map((c) => c.feeId)).toEqual(['tui']);
  });

  it('reports fees with no matching rate rule instead of failing', () => {
    const f = fee('tui', tuitionType, { rateRules: [{ ...anyRule('r', 1n), programCode: 'BSC-NUR' }] });
    expect(planObligations(student, [f], [])).toEqual({ create: [], skipped: [{ feeId: 'tui', reason: 'NO_RATE_RULE' }] });
  });

  it('PER_YEAR fees: a new year fee creates a new obligation', () => {
    const y1 = fee('tui-2025', tuitionType, { period: '2025/26' });
    const y2 = fee('tui-2026', tuitionType, { period: '2026/27' });
    const plan = planObligations(student, [y1, y2], [{ feeId: 'tui-2025', feeTypeId: 't-tui' }]);
    expect(plan.create.map((c) => c.feeId)).toEqual(['tui-2026']);
  });
});
