/**
 * Spawn rate limit — a resource guard for the exec-weight routes (originate,
 * restart-fresh) that each create a NEW claude process. Distinct from the auth
 * throttle (which counts auth FAILURES): this caps how fast an already-authed
 * caller can spawn, so a shared/leaked token or a runaway client can't storm
 * the box with processes. Pure sliding-window decision (injectable clock), in
 * per-IP memory. NOT an auth-model change — it's a cost/resource ceiling that
 * a public deployment needs and a single-user tailnet install never notices.
 */

export const SPAWN_WINDOW_MS = 60_000;
export const SPAWN_MAX_PER_WINDOW = 6;

const hits = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  return (hits.get(key) ?? []).filter((t) => now - t < SPAWN_WINDOW_MS);
}

/** Would a spawn right now exceed the window cap? (Check BEFORE spawning.) */
export function spawnLimited(key: string, now: number): boolean {
  return recent(key, now).length >= SPAWN_MAX_PER_WINDOW;
}

/** Record a spawn attempt against the window. */
export function recordSpawn(key: string, now: number): void {
  const r = recent(key, now);
  r.push(now);
  hits.set(key, r);
}

/** Test hook. */
export function _clear(): void {
  hits.clear();
}
