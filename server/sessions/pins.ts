/**
 * Per-session pin — the Bifrost-owned "keep this surfaced" flag (story 2-2, AC2.3).
 *
 * A pinned session always renders, bypassing BOTH the historyDays cutoff and the
 * maxHistory slice (see ./pinBypass.ts for the predicate). We persist only the
 * pinned ids (absent = not pinned), cached in memory and rewritten atomically on
 * each toggle — mirrors the alert-mute store (../alerts/sessions.ts) and the
 * `data/alert-sessions.json` + POST pattern.
 */
import { readJson, writeJsonAtomic } from "../alerts/store";

const FILE = "pinned-sessions.json";

interface Stored {
  pinned: string[];
}

let cache: Set<string> | null = null;

async function load(): Promise<Set<string>> {
  if (!cache) {
    const s = await readJson<Stored>(FILE, { pinned: [] });
    cache = new Set(s.pinned ?? []);
  }
  return cache;
}

/** The set of pinned session ids (read once per tick). */
export async function pinnedSessions(): Promise<Set<string>> {
  return load();
}

/** Toggle a session's pin; unpinned === default, so it drops from the set. */
export async function setSessionPin(sessionId: string, pinned: boolean): Promise<void> {
  const set = await load();
  if (pinned) set.add(sessionId);
  else set.delete(sessionId);
  await writeJsonAtomic(FILE, { pinned: [...set] });
}

/** Test-only: drop the in-memory cache so a fresh read hits disk. */
export function _resetPinCache(): void {
  cache = null;
}
