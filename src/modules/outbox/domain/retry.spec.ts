import { afterFailure } from './retry';

describe('outbox backoff 1m, 5m, 30m, 2h, 12h, then DEAD', () => {
  const now = new Date('2026-11-17T00:00:00Z');
  const mins = (n: number) => new Date(now.getTime() + n * 60_000);
  it.each([
    [1, mins(1)],
    [2, mins(5)],
    [3, mins(30)],
    [4, mins(120)],
    [5, mins(720)],
  ])('after failed attempt %i', (attempts, at) => {
    expect(afterFailure(attempts, now)).toEqual({ kind: 'retry', at });
  });
  it('dies after the 6th failure', () => expect(afterFailure(6, now)).toEqual({ kind: 'dead' }));
});
