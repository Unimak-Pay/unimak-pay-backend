import { collectionRate, EMPTY_TOTALS, standing, sumTotals } from './standing';

describe('standing', () => {
  it('no obligations is NOT_BILLED', () => {
    expect(standing({ obligations: 0, billed: 0n, collected: 0n, outstanding: 0n })).toBe('NOT_BILLED');
  });

  it('nothing outstanding is PAID, overpaid included', () => {
    expect(standing({ obligations: 1, billed: 100n, collected: 100n, outstanding: 0n })).toBe('PAID');
    expect(standing({ obligations: 1, billed: 0n, collected: 0n, outstanding: 0n })).toBe('PAID');
  });

  it('outstanding with something collected is PART_PAID, with nothing collected UNPAID', () => {
    expect(standing({ obligations: 2, billed: 300n, collected: 100n, outstanding: 200n })).toBe('PART_PAID');
    expect(standing({ obligations: 1, billed: 300n, collected: 0n, outstanding: 300n })).toBe('UNPAID');
  });

  it('a refund that cancels the only payment is UNPAID again', () => {
    expect(standing({ obligations: 1, billed: 300n, collected: 0n, outstanding: 300n })).toBe('UNPAID');
  });
});

describe('collectionRate', () => {
  it('is collected ÷ billed to 3 decimals, null when nothing billed', () => {
    expect(collectionRate(0n, 0n)).toBeNull();
    expect(collectionRate(3000n, 1000n)).toBe(0.333);
    expect(collectionRate(100n, 100n)).toBe(1);
  });

  it('stays within 0–1', () => {
    expect(collectionRate(100n, 150n)).toBe(1);
    expect(collectionRate(100n, -5n)).toBe(0);
  });
});

describe('sumTotals', () => {
  it('adds cells and computes the overall rate', () => {
    const a = { ...EMPTY_TOTALS, students: 2, billed: 1000n, collected: 400n, outstanding: 600n, paid: 0, partPaid: 1, unpaid: 1, overdue: 1, overdueAmount: 500n };
    const b = { ...EMPTY_TOTALS, students: 1, billed: 500n, collected: 500n, paid: 1 };
    expect(sumTotals([a, b])).toEqual({
      students: 3, billed: 1500n, collected: 900n, outstanding: 600n, paid: 1, partPaid: 1, unpaid: 1, overdue: 1, overdueAmount: 500n, collectionRate: 0.6,
    });
  });

  it('is empty with no cells', () => {
    expect(sumTotals([])).toEqual({ ...EMPTY_TOTALS, collectionRate: null });
  });
});
