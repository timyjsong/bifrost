/**
 * Idle-park sweeper — the impure half (park.ts decides; this carries out).
 * Runs on the slow tick. §4 invariants: NEVER touches disk state — it frees
 * RAM by killing processes only. §8 scale safety: every verdict is logged to
 * the action log (data/park-log.jsonl), kills are capped per sweep, and the
 * kill refuses any tmux name that isn't the session's own bifrost-spawn-
 * <uuid8> (a mismapped name must not kill the wrong window).
 *
 * Kill sequence (§3, the method phase-1 proved non-corrupting): SIGTERM the
 * claude pid (graceful flush) → poll /proc gone (≤10s) → kill the tmux
 * window. The parked uuid lands in data/parked.json — provenance that this
 * was a Bifrost park, not a crash (resume works from the transcript either
 * way).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir, readJson, writeJsonAtomic } from "../alerts/store";
import type { ParkLogEntry } from "../../shared/types";

const PARKED_FILE = "parked.json";
const PARK_LOG_FILE = "park-log.jsonl";

export type ParkedStore = Record<string, { at: number; cwd: string }>;

export async function readParked(): Promise<ParkedStore> {
  return readJson<ParkedStore>(PARKED_FILE, {});
}

export async function markParked(uuid: string, cwd: string, at: number): Promise<void> {
  const store = await readParked();
  store[uuid] = { at, cwd };
  await writeJsonAtomic(PARKED_FILE, store);
}

/** Append one action-log line (§8: what, why, when — for every verdict acted on). */
export async function logParkAction(entry: ParkLogEntry): Promise<void> {
  await appendFile(join(dataDir, PARK_LOG_FILE), JSON.stringify(entry) + "\n");
}

/**
 * Parse the action log's tail into entries, newest first, bounded to `limit`.
 * Tolerant of a partial leading line (a byte-offset tail read may start
 * mid-line) and any corrupt line — both simply skip. Pure.
 */
export function parseParkLog(text: string, limit: number): ParkLogEntry[] {
  const out: ParkLogEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line) as ParkLogEntry;
      if (
        typeof d.at === "number" &&
        typeof d.uuid === "string" &&
        (d.mode === "kill" || d.mode === "observe")
      ) {
        out.push(d);
      }
    } catch {
      /* partial/corrupt line — skip */
    }
  }
  return out.reverse().slice(0, Math.max(0, limit)); // newest first
}

/** Read the recent action-log entries (tail-bounded), newest first. */
export async function readParkLog(limit = 50): Promise<ParkLogEntry[]> {
  try {
    const f = Bun.file(join(dataDir, PARK_LOG_FILE));
    const size = f.size;
    const text = await f.slice(Math.max(0, size - 65_536), size).text();
    return parseParkLog(text, limit);
  } catch {
    return [];
  }
}

/**
 * Is a queued operation pending after the last completed assistant turn?
 * (§3.3 — a queued message DIES on park, so its presence hard-blocks.)
 * Pure over the transcript tail text.
 */
export function queuedOpPending(jsonlTail: string): boolean {
  let lastAssistant = -1;
  let lastQueued = -1;
  const lines = jsonlTail.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    try {
      const d = JSON.parse(l) as { type?: string };
      if (d.type === "assistant") lastAssistant = i;
      else if ((d.type ?? "").includes("queue")) lastQueued = i;
    } catch {
      /* partial tail line — ignore */
    }
  }
  return lastQueued > lastAssistant;
}

/** Any in-flight background job owned by this uuid? (§3.2 — hard-block.) */
export function inflightJobFor(uuid: string, jobsDir: string): boolean {
  if (!existsSync(jobsDir)) return false;
  for (const id of readdirSync(jobsDir)) {
    try {
      const st = JSON.parse(
        readFileSync(join(jobsDir, id, "state.json"), "utf8"),
      ) as { inFlight?: unknown; resumeSessionId?: string; sessionId?: string };
      if (!st.inFlight) continue;
      if (st.resumeSessionId === uuid || st.sessionId === uuid) return true;
    } catch {
      /* unreadable job dir — not evidence of flight */
    }
  }
  return false;
}

/**
 * SIGTERM → confirmed-gone → window kill. Refuses to act unless the tmux name
 * is exactly the session's own Bifrost-spawn name (§8 mapping check). Returns
 * whether the session was fully parked.
 */
export async function killForPark(deps: {
  uuid: string;
  pid: number;
  tmuxSession: string;
  killPane: (name: string) => Promise<number>;
  signal?: (pid: number) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const uuid8 = deps.uuid.replace(/-/g, "").slice(0, 8);
  if (deps.tmuxSession !== `bifrost-spawn-${uuid8}`) return false; // mapping check
  const signal = deps.signal ?? ((pid: number) => process.kill(pid, "SIGTERM"));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    signal(deps.pid);
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 40; i++) {
    if (!existsSync(`/proc/${deps.pid}`)) break;
    await sleep(250);
  }
  if (existsSync(`/proc/${deps.pid}`)) return false; // §3: never kill the window over a live process
  await deps.killPane(deps.tmuxSession);
  return true;
}
