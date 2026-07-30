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

/**
 * Whether the brute-force throttle should block THIS request. Scoped to the
 * auth-decision surface: only a request WITHOUT a valid token can be blocked, so
 * a shared proxy IP's failed auths never lock out a valid-token device (the
 * throttle key is the socket IP, which on the HTTPS route is caddy — shared
 * across every device). The caller verifies the token first, then consults this.
 */
export function throttleBlocks(tokenValid: boolean, ip: string, now: number): boolean {
  return !tokenValid && isThrottled(ip, now);
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
