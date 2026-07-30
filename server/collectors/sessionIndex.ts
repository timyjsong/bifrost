/**
 * Materialized, mtime-first session index (story 2-1).
 *
 * Reworks session enumeration so cold start no longer deep-parses every
 * within-cutoff transcript. The index is a stat-only ranking keyed by
 * sessionId; the deep parse (head+tail) runs only for live sessions plus the
 * newest dead candidates needed to fill `maxHistory` eligible interactive rows.
 * The index persists under `data/` (gitignored) and reloads + incrementally
 * refreshes by mtime on boot, so a warm start re-parses no unchanged file.
 *
 * Pure logic (name extraction, slug mapping, duplicate resolution, candidate
 * ranking, the bounded-parse loop) lives here and is unit-tested directly; the
 * collector wires it to disk.
 */
import { readJson, writeJsonAtomic } from "../alerts/store";

/** One indexed transcript. The cheap pass records `{mtimeMs, slug, cwd, name}`
 *  (AC1.2); `path`/`size` are carried so the deep parse and the saved-default
 *  scan can reuse the stat instead of re-walking the tree (AC1.5). */
export interface IndexEntry {
  sessionId: string;
  path: string;
  slug: string; // parent project-slug dir name
  mtimeMs: number;
  size: number;
  cwd: string; // from the transcript head (lossy slug is never reversed)
  name: string; // customTitle else basename(cwd)
}

/** The slug a cwd maps to. Lossy (`/` and `.` → `-`) and never reversed. */
export function slugFromCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** basename without importing node:path — the cwd is always POSIX here. */
export function basenameOf(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

/** The session's display name: the user-set title if any, else the cwd's
 *  basename. Empty cwd with no title yields "" (caller may fall back). */
export function nameFor(customTitle: string | undefined, cwd: string): string {
  if (customTitle && customTitle.trim()) return customTitle;
  return basenameOf(cwd);
}

/**
 * Deterministic winner when two transcripts share a sessionId across slug dirs
 * (AC1.4). Prefer the one whose slug matches `slugFromCwd(cwd)`; if neither (or
 * both) match, prefer the newest mtime, then the larger size, then the lexically
 * smaller path — so the choice is stable across sweeps and the list can't
 * flicker. Returns the winner; the caller logs one warning per collision.
 */
export function resolveDuplicate(a: IndexEntry, b: IndexEntry): IndexEntry {
  const aMatch = a.slug === slugFromCwd(a.cwd);
  const bMatch = b.slug === slugFromCwd(b.cwd);
  if (aMatch !== bMatch) return aMatch ? a : b;
  if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs > b.mtimeMs ? a : b;
  if (a.size !== b.size) return a.size > b.size ? a : b;
  return a.path <= b.path ? a : b;
}

/** Dead candidates ranked newest-first; live ids excluded (they always parse).
 *  Pure — operates on the already-collected stats, no I/O. */
export function rankDeadCandidates(
  entries: Iterable<IndexEntry>,
  liveIds: ReadonlySet<string>,
  cutoffMs: number,
): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const e of entries) {
    if (liveIds.has(e.sessionId)) continue;
    if (e.mtimeMs < cutoffMs) continue;
    out.push(e);
  }
  out.sort((x, y) => y.mtimeMs - x.mtimeMs);
  return out;
}

/**
 * Walk ranked dead candidates newest-first, parsing each via `parse`, until
 * `cap` ELIGIBLE interactive rows accumulate — then stop (AC1.1). A few extra
 * parses past `cap` are expected: eligibility (sidechain / scratch-cwd /
 * headless-vs-interactive) needs the parsed head, so non-eligible parses don't
 * count toward the cap but do cost a parse. `slack` bounds how many *extra*
 * non-eligible parses to tolerate after the cap is met — once `cap` eligible
 * rows are in hand we stop immediately, so the bound is `cap + (skipped seen
 * along the way)`, never O(N).
 *
 * `parse` returns the row to keep, or null to skip (vanished / sidechain /
 * filtered). `isEligible` decides whether a kept row counts toward the cap
 * (interactive) or is overflow (headless corpse). Pure aside from the injected
 * `parse` callback, so the bound is unit-testable with a counting fake.
 */
export async function boundedParse<Row>(
  ranked: IndexEntry[],
  cap: number,
  parse: (e: IndexEntry) => Promise<Row | null>,
  isEligible: (row: Row) => boolean,
): Promise<{ rows: Row[]; parsed: number }> {
  const rows: Row[] = [];
  let eligible = 0;
  let parsed = 0;
  for (const e of ranked) {
    if (eligible >= cap) break;
    parsed++;
    const row = await parse(e);
    if (!row) continue;
    rows.push(row);
    if (isEligible(row)) eligible++;
  }
  return { rows, parsed };
}

// --- Persistence ----------------------------------------------------------

const INDEX_FILE = "session-index.json";
const INDEX_VERSION = 1;

interface PersistedIndex {
  version: number;
  entries: IndexEntry[];
}

/** Load the persisted index from `data/` (returns empty map on first boot or a
 *  version/shape mismatch — the next sweep rebuilds it). */
export async function loadIndex(): Promise<Map<string, IndexEntry>> {
  const data = await readJson<PersistedIndex | null>(INDEX_FILE, null);
  const map = new Map<string, IndexEntry>();
  if (!data || data.version !== INDEX_VERSION || !Array.isArray(data.entries)) {
    return map;
  }
  for (const e of data.entries) {
    if (e && typeof e.sessionId === "string") map.set(e.sessionId, e);
  }
  return map;
}

/** Persist the index atomically under `data/` (gitignored). */
export async function saveIndex(map: Map<string, IndexEntry>): Promise<void> {
  const payload: PersistedIndex = {
    version: INDEX_VERSION,
    entries: [...map.values()],
  };
  await writeJsonAtomic(INDEX_FILE, payload);
}
