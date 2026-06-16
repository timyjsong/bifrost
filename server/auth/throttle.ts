/**
 * Brute-force throttle — a per-IP sliding-window counter of failed auths. The
 * tailnet's single-user perimeter already makes online guessing unlikely; this
 * neutralizes it regardless, with no persistence (in-memory; a restart resets).
 */
export const THROTTLE_WINDOW_MS = 60_000;
export const THROTTLE_MAX_FAILS = 10;

const hits = new Map<string, number[]>(); // ip -> failure timestamps in-window

function recent(ip: string, now: number): number[] {
  return (hits.get(ip) ?? []).filter((t) => now - t < THROTTLE_WINDOW_MS);
}

export function isThrottled(ip: string, now: number): boolean {
  return recent(ip, now).length >= THROTTLE_MAX_FAILS;
}

export function recordFailure(ip: string, now: number): void {
  const arr = recent(ip, now);
  arr.push(now);
  hits.set(ip, arr);
}

/** Test-only: clear all counters. */
export function _clear(): void {
  hits.clear();
}
