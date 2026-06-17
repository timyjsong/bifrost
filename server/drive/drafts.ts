/**
 * Per-session prompt drafts — the uncommitted input buffer, stored server-side so
 * it follows the user across devices (start typing on the desktop, finish on the
 * phone). Keyed by sessionId; last write wins (no conflict UI — single-user). A
 * sent prompt clears its draft. Reuses the durable atomic JSON store under data/.
 */
import { readJson, writeJsonAtomic } from "../alerts/store";

const FILE = "drafts.json";
type Drafts = Record<string, string>;

let cache: Drafts | null = null;

async function load(): Promise<Drafts> {
  if (!cache) cache = await readJson<Drafts>(FILE, {});
  return cache;
}

export async function getDraft(sessionId: string): Promise<string> {
  return (await load())[sessionId] ?? "";
}

/** Set (or, for empty text, clear) a session's draft. Last write wins. */
export async function setDraft(sessionId: string, text: string): Promise<void> {
  const d = await load();
  if (text) d[sessionId] = text;
  else delete d[sessionId];
  await writeJsonAtomic(FILE, d);
}
