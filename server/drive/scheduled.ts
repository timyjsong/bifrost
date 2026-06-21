/**
 * Server-side scheduled sends — the send grace buffer. A submitted prompt isn't
 * injected immediately; it's parked here for the grace period, during which a
 * cancel aborts it. The timer lives on the (always-running) server, so closing
 * the app inside the window does NOT lose the send — it still fires. That's the
 * whole reason this is server-side rather than a client setTimeout.
 *
 * Keyed by sessionId: the UI locks input during the window, so there's at most
 * one pending send per session; scheduling a new one supersedes any existing.
 * In-memory only — a pending send is lost solely if the bifrost service itself
 * restarts inside the window (rare; the window is seconds). This module owns only
 * the timer/registry; the caller supplies the actual injection as `onFire`, so it
 * stays free of tmux/snapshot knowledge.
 */
type Pending = { timer: ReturnType<typeof setTimeout>; fireAt: number };

const pending = new Map<string, Pending>();

/**
 * Park a send for `delayMs`, then run `onFire`. Supersedes any existing pending
 * send for the session (cancels it first — never two stacked for one session).
 * delayMs <= 0 still goes through setTimeout(0): the fire is async and remains
 * cancellable within that tick, so there's no special-cased immediate path.
 * Returns `fireAt` (epoch ms) for the caller to relay if it wants.
 */
export function schedule(
  sessionId: string,
  delayMs: number,
  onFire: () => void | Promise<void>,
): { fireAt: number } {
  cancel(sessionId);
  const ms = Math.max(0, delayMs);
  const fireAt = Date.now() + ms;
  const timer = setTimeout(() => {
    pending.delete(sessionId);
    void onFire();
  }, ms);
  pending.set(sessionId, { timer, fireAt });
  return { fireAt };
}

/**
 * Cancel a session's pending send if it hasn't fired. Returns whether one was
 * actually cancelled: `false` means nothing was pending (unknown session, or it
 * already fired in the last-instant race) — the caller treats that as "already
 * sent" and does NOT restore the user's text.
 */
export function cancel(sessionId: string): boolean {
  const p = pending.get(sessionId);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(sessionId);
  return true;
}

/** Test/inspection helper: is a send currently parked for this session? */
export function isPending(sessionId: string): boolean {
  return pending.has(sessionId);
}
