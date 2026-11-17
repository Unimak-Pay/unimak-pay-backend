/** Wait after the Nth failed attempt (1-based). After the last one → DEAD. */
export const RETRY_BACKOFF_MS = [
  60_000, // 1m
  5 * 60_000, // 5m
  30 * 60_000, // 30m
  2 * 60 * 60_000, // 2h
  12 * 60 * 60_000, // 12h
] as const;

export type RetryDecision = { kind: 'retry'; at: Date } | { kind: 'dead' };

export function afterFailure(attemptsSoFar: number, now: Date): RetryDecision {
  const wait = RETRY_BACKOFF_MS[attemptsSoFar - 1];
  return wait === undefined ? { kind: 'dead' } : { kind: 'retry', at: new Date(now.getTime() + wait) };
}
