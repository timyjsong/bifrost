/**
 * Pin bypass predicate (story 2-2, AC2.3 / red-team §M1).
 *
 * The default list drops every transcript older than `historyDays` (the cutoff)
 * and then caps the dead set at `maxHistory` (the slice). A PINNED session must
 * render regardless — bypassing BOTH cutoffs. This is the pure predicate the
 * collector uses to decide which pinned sessions the normal bounded pass left
 * out, so it can pull them back from the full uncapped index.
 *
 * Pure (no I/O): operates on already-collected index entries + the set of ids
 * that already made the bounded list. Unit-tested directly.
 */
import type { IndexEntry } from "../collectors/sessionIndex";

/**
 * True if `sessionId` is pinned but absent from the bounded list — i.e. a cutoff
 * dropped it (older than historyDays, or sliced past maxHistory) and pin should
 * rescue it. A pinned session already in the bounded list needs no rescue.
 */
export function needsPinRescue(
  sessionId: string,
  pinned: ReadonlySet<string>,
  boundedIds: ReadonlySet<string>,
): boolean {
  return pinned.has(sessionId) && !boundedIds.has(sessionId);
}

/**
 * The full set of pinned index entries that the bounded pass left out and that
 * pin must rescue (AC2.3). Live sessions are never here — they always render —
 * and a pinned session already in `boundedIds` is skipped (no duplicate). The
 * caller deep-parses these and appends them so a pinned old/over-cap session
 * always renders. Returned newest-first for a stable order.
 *
 * Crucially this consults NEITHER the historyDays cutoff NOR the maxHistory cap:
 * pin bypasses both, so any pinned entry not already shown is rescued outright.
 */
export function pinnedToRescue(
  index: Iterable<IndexEntry>,
  pinned: ReadonlySet<string>,
  boundedIds: ReadonlySet<string>,
  liveIds: ReadonlySet<string>,
): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const e of index) {
    if (liveIds.has(e.sessionId)) continue; // live always renders
    if (needsPinRescue(e.sessionId, pinned, boundedIds)) out.push(e);
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
