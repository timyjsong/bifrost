/**
 * Stream-staleness logic for the two SSE consumers (dashboard snapshot stream,
 * per-session drive stream). A hung TCP stream (mobile network path change, a
 * sleeping proxy — no FIN ever arrives) leaves the reader pending forever; the
 * only tell is silence. Both servers heartbeat every 25s, so a stream that has
 * produced nothing — frames OR pings — past its threshold is dead: abort it
 * and redial rather than waiting on a read that will never return.
 */

/** Has the stream been silent past the threshold? (Hung — abort and redial.) */
export function streamQuiet(lastActivityAt: number, now: number, quietMs: number): boolean {
  return now - lastActivityAt >= quietMs;
}

/** Dashboard quiet threshold: snapshots push every few seconds; 15s is dead. */
export const SNAPSHOT_QUIET_MS = 15_000;

/** Per-session quiet threshold: pushes only on transcript writes, so the 25s
 *  heartbeat is the floor signal — two missed beats plus slack means hung. */
export const SESSION_QUIET_MS = 60_000;

/** Label for the staleness chip: how old the data on screen actually is. */
export function staleLabel(generatedAt: number | undefined, now: number): string {
  if (!generatedAt) return "stale";
  const s = Math.max(0, Math.floor((now - generatedAt) / 1000));
  if (s < 60) return `stale ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `stale ${m}m`;
  return `stale ${Math.floor(m / 60)}h`;
}
