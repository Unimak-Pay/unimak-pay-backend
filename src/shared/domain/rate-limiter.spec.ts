import { FixedWindowLimiter } from './rate-limiter';

describe('FixedWindowLimiter', () => {
  it('allows up to the limit per window, then resets', () => {
    const l = new FixedWindowLimiter(2, 60_000);
    expect([l.hit('a', 0), l.hit('a', 1), l.hit('a', 2)]).toEqual([true, true, false]);
    expect(l.hit('b', 3)).toBe(true); // keys are independent
    expect(l.retryAfter('a', 30_000)).toBe(30);
    expect(l.hit('a', 60_000)).toBe(true);
  });

  it('never holds more than maxKeys', () => {
    const l = new FixedWindowLimiter(1, 60_000, 3);
    for (let i = 0; i < 10; i++) l.hit(`k${i}`, i);
    expect((l as unknown as { windows: Map<string, unknown> }).windows.size).toBeLessThanOrEqual(3);
  });
});
