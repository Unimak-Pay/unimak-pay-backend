import { NightlyReconciliationService } from './nightly-reconciliation.service';

describe('reconciliation window', () => {
  it('is the previous UTC day (Sierra Leone is UTC+0)', () => {
    const { start, end } = NightlyReconciliationService.previousDay(new Date('2026-11-18T01:00:00Z'));
    expect(start.toISOString()).toBe('2026-11-17T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-18T00:00:00.000Z');
  });
});
