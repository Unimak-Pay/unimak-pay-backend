/**
 * Fixed-window counter per key, in memory. On Vercel each function instance keeps its
 * own counters, so this is a per-instance brake, not a global quota (a Vercel Firewall
 * rate-limit rule is the global one).
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Counts one hit; false when the key is over the limit in the current window. */
  hit(key: string, now = Date.now()): boolean {
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      if (!w && this.windows.size >= this.maxKeys) this.sweep(now);
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count++;
    return w.count <= this.limit;
  }

  /** True when the key has used up the current window (does not count a hit). */
  exhausted(key: string, now = Date.now()): boolean {
    const w = this.windows.get(key);
    return !!w && now - w.start < this.windowMs && w.count >= this.limit;
  }

  /** Seconds until the key's window resets. */
  retryAfter(key: string, now = Date.now()): number {
    const w = this.windows.get(key);
    return w ? Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000)) : 0;
  }

  private sweep(now: number): void {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
    // still full (a flood of distinct keys): drop the oldest entries
    while (this.windows.size >= this.maxKeys) this.windows.delete(this.windows.keys().next().value!);
  }
}
