/**
 * Drive-target validation — the load-bearing security boundary for writing INTO
 * sessions (the Channel-2 analog of files/confine.ts). A send is admitted ONLY
 * if the requested session is tmux-resident AND its tmux session is still live
 * in the current snapshot. Pure: it decides on plain data (the session's derived
 * tmuxSession + the set of live tmux session names), so the contract is fully
 * testable and the executor (./send.ts) stays a thin shell that never decides.
 *
 * Why exact membership is the whole check: live session names come from tmux
 * itself (`tmux ls`), so a forged or stale name simply isn't in the set. There
 * is no name to sanitize — an unknown string is rejected, not cleaned.
 */

export type DriveTarget =
  | { ok: true; tmuxSession: string }
  | { ok: false; reason: "not-injectable" | "session-gone" };

/**
 * Resolve a Claude session to a validated, live tmux send-keys target.
 * - `not-injectable`: the session isn't tmux-resident (no derived tmuxSession) —
 *   the control is shown disabled with this reason, never a silent no-op.
 * - `session-gone`: it names a tmux session no longer present in `live` — the
 *   pane died between render and send; the caller surfaces a loud failure.
 *
 * Call this with a FRESH `live` set at SEND time (not only at render) so a
 * session that died after the UI rendered yields a clean rejection (AC1.4).
 */
export function resolveTarget(
  session: { tmuxSession?: string } | undefined,
  live: ReadonlySet<string>,
): DriveTarget {
  const name = session?.tmuxSession;
  if (!name) return { ok: false, reason: "not-injectable" };
  if (!live.has(name)) return { ok: false, reason: "session-gone" };
  return { ok: true, tmuxSession: name };
}

/** Live tmux session names from a `collectTmux()` snapshot — the membership set
 *  resolveTarget validates against. */
export function liveTmuxSet(tmux: { name: string }[]): Set<string> {
  return new Set(tmux.map((t) => t.name));
}
