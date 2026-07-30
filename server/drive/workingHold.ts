/**
 * Server-side hold for the pane "working" reading. The spinner's timer line —
 * the primary turn evidence since the 2026-07 TUI dropped "esc to interrupt" —
 * can miss a capture during transitional redraws. Rather than let one blank
 * frame flip send-gating open mid-turn, a positive reading holds `working`
 * true for a short window; the state decays to idle only after the pane has
 * read idle for the full hold. Pure decision + injectable clock; in-memory
 * like the pending-send registry (a hold matters for seconds, not restarts).
 */
export const WORKING_HOLD_MS = 3_000;

const lastPositive = new Map<string, number>();

export function heldWorking(
  sessionId: string,
  rawWorking: boolean,
  now: number = Date.now(),
  holdMs: number = WORKING_HOLD_MS,
): boolean {
  if (rawWorking) {
    lastPositive.set(sessionId, now);
    return true;
  }
  const last = lastPositive.get(sessionId);
  if (last !== undefined && now - last < holdMs) return true;
  lastPositive.delete(sessionId);
  return false;
}
