/**
 * The recent-alerts feed: a bounded, in-memory log of what the engine fired,
 * so a device that missed the push (or never subscribed) still has a record.
 * The state lives in the manager; this is the pure ring-buffer step.
 */
import type { RecentAlert } from "../../shared/alerts";

/**
 * Prepend this tick's fired alerts (newest first) and bound the log to `cap`,
 * dropping the oldest. `incoming` empty → the buffer is returned unchanged.
 */
export function pushRecent(
  buf: RecentAlert[],
  incoming: RecentAlert[],
  cap: number,
): RecentAlert[] {
  if (incoming.length === 0) return buf;
  return [...incoming, ...buf].slice(0, Math.max(0, cap));
}
