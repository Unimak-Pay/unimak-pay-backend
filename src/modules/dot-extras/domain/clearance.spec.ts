import { evaluateClearance, isPassCode, isPastDue, newPassCode } from './clearance';

const now = new Date('2026-11-26T12:00:00Z');
const rule = { examName: 'First semester exams', period: '2026/27', feeTypeCodes: ['TUITION'], includeOverdue: true };
const ob = (over: object) => ({ id: 'o', feeName: 'Tuition 2026/27', feeTypeCode: 'TUITION', period: '2026/27', dueDate: null, balance: 0n, ...over });

describe('clearance', () => {
  it('cleared when listed fees of the period and overdue fees are paid', () => {
    expect(evaluateClearance(rule, [ob({}), ob({ id: 'd', feeTypeCode: 'DEPT', balance: 500n })], now)).toEqual({ cleared: true, outstanding: 0n, blocking: [] });
  });

  it('a listed fee of the period with a balance blocks', () => {
    expect(evaluateClearance(rule, [ob({ balance: 1000n })], now)).toEqual({ cleared: false, outstanding: 1000n, blocking: [{ obligationId: 'o', feeName: 'Tuition 2026/27', balance: 1000n }] });
  });

  it('a listed fee of another period does not, unless overdue', () => {
    expect(evaluateClearance(rule, [ob({ period: '2025/26', balance: 1000n })], now).cleared).toBe(true);
    expect(evaluateClearance(rule, [ob({ period: '2025/26', balance: 1000n, dueDate: new Date('2026-07-31T00:00:00Z') })], now).cleared).toBe(false);
  });

  it('any fee past its due date blocks when includeOverdue', () => {
    const late = ob({ id: 'd', feeTypeCode: 'DEPT', feeName: 'Departmental', balance: 300n, dueDate: new Date('2026-11-01T00:00:00Z') });
    expect(evaluateClearance(rule, [late], now)).toMatchObject({ cleared: false, outstanding: 300n });
    expect(evaluateClearance({ ...rule, includeOverdue: false }, [late], now).cleared).toBe(true);
  });

  it('past due only after the due day ends', () => {
    expect(isPastDue(new Date('2026-11-26T00:00:00Z'), now)).toBe(false);
    expect(isPastDue(new Date('2026-11-25T00:00:00Z'), now)).toBe(true);
    expect(isPastDue(null, now)).toBe(false);
  });

  it('pass codes are 8 readable characters', () => {
    expect(isPassCode(newPassCode())).toBe(true);
    expect(isPassCode('ABCDEFG')).toBe(false);
  });
});
