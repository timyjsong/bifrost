import { readFileSync } from "node:fs";
import { readdir, stat, open } from "node:fs/promises";
import { join, basename } from "node:path";
import type { SessionInfo } from "../../shared/types";
import type { AtriumConfig } from "../config";

interface LivePidFile {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  procStart?: string;
  kind?: string;
  status?: string;
  statusUpdatedAt?: number;
  entrypoint?: string;
}

/** Raw per-session signals for state derivation (kept out of the snapshot). */
export interface SessionSignals {
  lastEntry?: TailEntry;
  openTools: number;
  cpuQuietMs?: number;
  pidStatus?: string;
  pidStatusAgeMs?: number;
  kind?: string;
}

interface TranscriptHead {
  sessionId: string;
  cwd?: string;
  gitBranch?: string;
  startedAt?: number;
  title?: string;
  entrypoint?: string;
  sidechain: boolean;
}

export type TailEntry =
  | "assistant_done" // completed turn, model waiting
  | "assistant_tool" // assistant emitted tool calls (or mid-message)
  | "user_prompt" // user typed; model is (about to be) generating
  | "tool_result"; // tool finished; model is generating

interface TranscriptTail {
  contextTokens?: number;
  model?: string;
  lastTimestamp?: number;
  lastEntry?: TailEntry;
  openTools: number;
  nowDoing?: string;
}

interface FileStat {
  path: string;
  mtimeMs: number;
  size: number;
}

interface TranscriptCacheEntry {
  mtimeMs: number;
  size: number;
  head: TranscriptHead | null; // immutable once parsed
  tail: TranscriptTail;
}

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 128 * 1024;
const FULL_SWEEP_MS = 30_000;

// sessionId -> latest known file stat. Rebuilt by the full sweep; live sessions'
// entries are re-stat'd every tick. Dead transcripts don't change between sweeps.
let fileIndex = new Map<string, FileStat>();
let lastFullSweep = 0;

const transcriptCache = new Map<string, TranscriptCacheEntry>();

// pid -> last CPU sample, for "is this process actually computing" detection.
const cpuTrack = new Map<number, { jiffies: number; quietSince: number }>();

/**
 * Read /proc/<pid>/stat: liveness (with pid-reuse guard via starttime) plus
 * cumulative CPU jiffies (utime+stime).
 */
function readProc(
  pid: number,
  procStart?: string,
): { alive: boolean; jiffies: number } {
  try {
    const statLine = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm (field 2) may contain spaces — parse fields after the closing paren.
    // After ") ", index 0 is field 3 (state): utime=idx 11, stime=idx 12, starttime=idx 19.
    const after = statLine.slice(statLine.lastIndexOf(")") + 2).trimStart().split(" ");
    if (procStart && after[19] !== procStart) return { alive: false, jiffies: 0 };
    return { alive: true, jiffies: Number(after[11]) + Number(after[12]) };
  } catch {
    return { alive: false, jiffies: 0 };
  }
}

/** Update the CPU tracker for a live pid; returns how long it has been CPU-quiet. */
function trackCpu(pid: number, jiffies: number, now: number): number {
  const prev = cpuTrack.get(pid);
  if (!prev) {
    cpuTrack.set(pid, { jiffies, quietSince: now });
    return 0;
  }
  // >2 jiffies (~20ms CPU) since last tick = actively computing.
  const busy = jiffies - prev.jiffies > 2;
  const quietSince = busy ? now : prev.quietSince;
  cpuTrack.set(pid, { jiffies, quietSince });
  return now - quietSince;
}

function isHeadless(entrypoint?: string): boolean | undefined {
  return entrypoint ? /sdk/.test(entrypoint) : undefined;
}

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === "object" && (item as any).type === "text") {
        const t = (item as any).text;
        if (typeof t === "string" && t.trim()) return t;
      }
    }
  }
  return undefined;
}

function cleanTitle(raw: string): string {
  const line = raw.replace(/\s+/g, " ").trim();
  return line.length > 140 ? line.slice(0, 137) + "…" : line;
}

async function readChunk(
  path: string,
  position: number,
  length: number,
): Promise<string> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

function parseHead(chunk: string, fileSessionId: string): TranscriptHead | null {
  const head: TranscriptHead = { sessionId: fileSessionId, sidechain: false };
  let foundUser = false;
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue; // truncated final line of the chunk
    }
    if (d.isSidechain === true) head.sidechain = true;
    if (d.type === "user" && d.message?.role === "user") {
      head.cwd = d.cwd ?? head.cwd;
      head.gitBranch = d.gitBranch ?? head.gitBranch;
      head.entrypoint = d.entrypoint ?? head.entrypoint;
      if (d.timestamp) head.startedAt = Date.parse(d.timestamp);
      const text = extractText(d.message.content);
      // Skip harness-injected wrappers; keep looking for the first real prompt.
      if (text && !text.startsWith("Caveat:") && !text.startsWith("<")) {
        head.title = cleanTitle(text);
        foundUser = true;
        break;
      }
      if (!foundUser && text) head.title = cleanTitle(text);
    }
  }
  return head.cwd || head.title ? head : null;
}

function parseTail(chunk: string): TranscriptTail {
  const tail: TranscriptTail = { openTools: 0 };
  const toolUses = new Set<string>();
  const toolResults = new Set<string>();
  // Forward pass: later lines overwrite, so the final values reflect the file end.
  // Tool accounting within the window is sound — results always follow their use.
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue; // truncated first/last line of the window
    }
    if (d.timestamp) tail.lastTimestamp = Date.parse(d.timestamp);
    const m = d.message;
    if (d.type === "assistant" && m?.role === "assistant") {
      if (m.usage?.input_tokens !== undefined) {
        const u = m.usage;
        tail.contextTokens =
          (u.input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0);
        tail.model = m.model ?? tail.model;
      }
      let hasToolUse = false;
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type === "tool_use" && c.id) {
          toolUses.add(c.id);
          hasToolUse = true;
        }
        if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
          tail.nowDoing = cleanTitle(c.text).slice(0, 120);
        }
      }
      // Only a stop_reason of end_turn with no tool calls means "turn over".
      tail.lastEntry =
        m.stop_reason === "end_turn" && !hasToolUse
          ? "assistant_done"
          : "assistant_tool";
    } else if (d.type === "user" && m?.role === "user") {
      const content = m.content;
      if (
        Array.isArray(content) &&
        content.some((c: any) => c?.type === "tool_result")
      ) {
        for (const c of content) {
          if (c?.type === "tool_result" && c.tool_use_id) {
            toolResults.add(c.tool_use_id);
          }
        }
        tail.lastEntry = "tool_result";
      } else {
        tail.lastEntry = "user_prompt";
      }
    }
  }
  tail.openTools = [...toolUses].filter((id) => !toolResults.has(id)).length;
  return tail;
}

/** Parse (or reuse cached parse of) a transcript, given an already-known stat. */
async function scanTranscript(
  st: FileStat,
): Promise<TranscriptCacheEntry | null> {
  const cached = transcriptCache.get(st.path);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached;
  }
  const sessionId = basename(st.path, ".jsonl");
  let head: TranscriptHead | null;
  let tail: TranscriptTail;
  try {
    head =
      cached?.head ??
      parseHead(await readChunk(st.path, 0, HEAD_BYTES), sessionId);
    const tailStart = Math.max(0, st.size - TAIL_BYTES);
    tail = parseTail(await readChunk(st.path, tailStart, TAIL_BYTES));
  } catch {
    return null; // file vanished mid-read
  }
  const entry: TranscriptCacheEntry = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    head,
    tail,
  };
  transcriptCache.set(st.path, entry);
  return entry;
}

/** Re-index every transcript on disk. Stats run in parallel; called on the slow cadence. */
async function fullSweep(claudeDir: string): Promise<void> {
  const projectsDir = join(claudeDir, "projects");
  let slugs: string[] = [];
  try {
    slugs = await readdir(projectsDir);
  } catch {
    return;
  }
  const paths: string[] = [];
  await Promise.all(
    slugs.map(async (slug) => {
      try {
        for (const f of await readdir(join(projectsDir, slug))) {
          if (f.endsWith(".jsonl") && !f.startsWith("agent-")) {
            paths.push(join(projectsDir, slug, f));
          }
        }
      } catch {
        // dir vanished mid-scan
      }
    }),
  );
  const next = new Map<string, FileStat>();
  await Promise.all(
    paths.map(async (path) => {
      try {
        const st = await stat(path);
        next.set(basename(path, ".jsonl"), {
          path,
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      } catch {
        // file vanished mid-scan
      }
    }),
  );
  fileIndex = next;
  // Drop parse-cache entries for files that no longer exist.
  const livePaths = new Set([...next.values()].map((f) => f.path));
  for (const path of transcriptCache.keys()) {
    if (!livePaths.has(path)) transcriptCache.delete(path);
  }
}

async function collectLive(
  claudeDir: string,
): Promise<Map<string, LivePidFile & { cpuQuietMs: number }>> {
  const live = new Map<string, LivePidFile & { cpuQuietMs: number }>();
  let files: string[] = [];
  try {
    files = await readdir(join(claudeDir, "sessions"));
  } catch {
    return live;
  }
  const now = Date.now();
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(
        readFileSync(join(claudeDir, "sessions", f), "utf8"),
      ) as LivePidFile;
      if (!d.pid || !d.sessionId) continue;
      const proc = readProc(d.pid, d.procStart);
      if (!proc.alive) continue;
      live.set(d.sessionId, {
        ...d,
        cpuQuietMs: trackCpu(d.pid, proc.jiffies, now),
      });
    } catch {
      // unreadable/partial pid file — treat as not live
    }
  }
  // prune tracker entries for pids no longer live
  const livePids = new Set([...live.values()].map((d) => d.pid));
  for (const pid of cpuTrack.keys()) {
    if (!livePids.has(pid)) cpuTrack.delete(pid);
  }
  return live;
}

export interface SessionsResult {
  sessions: SessionInfo[];
  signals: Map<string, SessionSignals>;
  livePids: Map<string, number>; // sessionId -> pid (for child-proc counting)
}

export async function collectSessions(
  cfg: AtriumConfig,
): Promise<SessionsResult> {
  const live = await collectLive(cfg.claudeDir);
  const scratch = cfg.summarize.scratchDir;
  // Atrium's own summarizer sessions never appear in the dashboard.
  for (const [sid, lp] of live) {
    if (lp.cwd === scratch || lp.cwd.startsWith(scratch + "/")) live.delete(sid);
  }

  const now = Date.now();
  if (now - lastFullSweep > FULL_SWEEP_MS) {
    await fullSweep(cfg.claudeDir);
    lastFullSweep = now;
  }

  // Per tick, re-stat only live sessions' transcripts — dead ones don't change.
  await Promise.all(
    [...live.values()].map(async (lp) => {
      const known = fileIndex.get(lp.sessionId);
      // New sessions may not be indexed yet; derive the path from the cwd slug.
      const path =
        known?.path ??
        join(
          cfg.claudeDir,
          "projects",
          lp.cwd.replace(/[/.]/g, "-"),
          `${lp.sessionId}.jsonl`,
        );
      try {
        const st = await stat(path);
        fileIndex.set(lp.sessionId, { path, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // transcript not on disk yet
      }
    }),
  );

  const cutoff = now - cfg.sessions.historyDays * 86_400_000;
  const out: SessionInfo[] = [];
  const seen = new Set<string>();
  const signals = new Map<string, SessionSignals>();

  for (const [sessionId, fs] of fileIndex) {
    const lp = live.get(sessionId);
    if (!lp && fs.mtimeMs < cutoff) continue;
    const entry = await scanTranscript(fs);
    if (!entry || !entry.head || entry.head.sidechain) continue;
    const cwd = lp?.cwd ?? entry.head.cwd ?? "";
    if (cwd === scratch || cwd.startsWith(scratch + "/")) continue;
    seen.add(sessionId);
    if (lp) {
      signals.set(sessionId, {
        lastEntry: entry.tail.lastEntry,
        openTools: entry.tail.openTools,
        cpuQuietMs: lp.cpuQuietMs,
        pidStatus: lp.status,
        pidStatusAgeMs: lp.statusUpdatedAt
          ? now - lp.statusUpdatedAt
          : undefined,
        kind: lp.kind,
      });
    }
    out.push({
      sessionId,
      pid: lp?.pid,
      live: !!lp,
      kind: lp?.kind,
      status: lp?.status,
      entrypoint: lp?.entrypoint ?? entry.head.entrypoint,
      headless: isHeadless(lp?.entrypoint ?? entry.head.entrypoint),
      cwd: lp?.cwd ?? entry.head.cwd ?? "",
      title: entry.head.title,
      gitBranch: entry.head.gitBranch,
      model: entry.tail.model,
      startedAt: lp?.startedAt ?? entry.head.startedAt,
      lastActivityAt: entry.tail.lastTimestamp ?? fs.mtimeMs,
      contextTokens: entry.tail.contextTokens,
      transcriptBytes: fs.size,
      nowDoing: lp ? entry.tail.nowDoing : undefined,
    });
  }

  // Live sessions whose transcript we didn't find still deserve a row.
  for (const [sessionId, lp] of live) {
    if (seen.has(sessionId)) continue;
    signals.set(sessionId, {
      openTools: 0,
      cpuQuietMs: lp.cpuQuietMs,
      pidStatus: lp.status,
      pidStatusAgeMs: lp.statusUpdatedAt
        ? Date.now() - lp.statusUpdatedAt
        : undefined,
      kind: lp.kind,
    });
    out.push({
      sessionId,
      pid: lp.pid,
      live: true,
      kind: lp.kind,
      status: lp.status,
      entrypoint: lp.entrypoint,
      headless: isHeadless(lp.entrypoint),
      cwd: lp.cwd,
      startedAt: lp.startedAt,
      lastActivityAt: lp.startedAt,
    });
  }

  out.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    return b.lastActivityAt - a.lastActivityAt;
  });

  const liveRows = out.filter((s) => s.live);
  // Interactive history gets the cap; headless corpses only fill what's left,
  // so probe swarms can't bury real sessions.
  const dead = out.filter((s) => !s.live);
  const deadInteractive = dead
    .filter((s) => !s.headless)
    .slice(0, cfg.sessions.maxHistory);
  const deadHeadless = dead
    .filter((s) => s.headless)
    .slice(0, Math.max(0, cfg.sessions.maxHistory - deadInteractive.length));
  const history = [...deadInteractive, ...deadHeadless].sort(
    (a, b) => b.lastActivityAt - a.lastActivityAt,
  );
  const livePids = new Map<string, number>();
  for (const [sid, lp] of live) livePids.set(sid, lp.pid);
  return { sessions: [...liveRows, ...history], signals, livePids };
}

/** Transcript path for a known session id, if indexed. */
export function transcriptPathFor(sessionId: string): string | undefined {
  return fileIndex.get(sessionId)?.path;
}

/** Latest known mtime for a session's transcript. */
export function transcriptMtimeFor(sessionId: string): number | undefined {
  return fileIndex.get(sessionId)?.mtimeMs;
}
