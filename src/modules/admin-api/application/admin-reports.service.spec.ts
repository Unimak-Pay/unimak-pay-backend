import { DomainError } from '../../../shared/domain/errors';
import { range } from './admin-reports.service';

describe('reports range', () => {
  const now = new Date('2026-11-19T15:30:00Z');

  it('defaults to the last 30 days including today (UTC = Africa/Freetown)', () => {
    expect(range({}, now)).toEqual({
      from: '2026-10-21', to: '2026-11-19', days: 30,
      start: new Date('2026-10-21T00:00:00Z'), end: new Date('2026-11-20T00:00:00Z'),
    });
  });

  it('is inclusive of both days', () => {
    expect(range({ from: '2026-11-01', to: '2026-11-01' }, now)).toMatchObject({ days: 1, end: new Date('2026-11-02T00:00:00Z') });
    expect(range({ from: '2026-01-01', to: '2026-12-31' }, now).days).toBe(365);
  });

  it('rejects bad, reversed and too-long ranges', () => {
    expect(() => range({ from: '2026-11-31x' }, now)).toThrow(DomainError);
    expect(() => range({ from: '2026-11-10', to: '2026-11-01' }, now)).toThrow('`from` must be on or before `to`');
    expect(() => range({ from: '2025-01-01', to: '2026-01-02' }, now)).toThrow('at most 366 days');
  });
});
