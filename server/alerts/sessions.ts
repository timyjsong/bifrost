/**
 * Per-session alert mute — the opt-out set behind the per-card toggle.
 *
 * Alerts are on for every session by default, so we persist only the *disabled*
 * ids (a session absent from the set is enabled, and a brand-new session is on
 * automatically). Cached in memory, rewritten atomically on each toggle —
 * mirrors the policy/subscription stores.
 */
import { readJson, writeJsonAtomic } from "./store";

const FILE = "alert-sessions.json";

interface Stored {
  disabled: string[];
}

let cache: Set<string> | null = null;

async function load(): Promise<Set<string>> {
  if (!cache) {
    const s = await readJson<Stored>(FILE, { disabled: [] });
    cache = new Set(s.disabled ?? []);
  }
  return cache;
}

/** The set of session ids with alerts muted (read once per tick). */
export async function mutedSessions(): Promise<Set<string>> {
  return load();
}

/** Toggle a session's alerts; enabled === default, so it drops from the set. */
export async function setSessionAlerts(sessionId: string, enabled: boolean): Promise<void> {
  const set = await load();
  if (enabled) set.delete(sessionId);
  else set.add(sessionId);
  await writeJsonAtomic(FILE, { disabled: [...set] });
}
