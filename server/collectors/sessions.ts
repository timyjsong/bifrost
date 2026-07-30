import { readFileSync } from "node:fs";
import { readdir, stat, open, readFile } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import type { SessionInfo } from "../../shared/types";
import {
  canonCommand,
  isPrintCmdline,
  launchModelFromCmdline,
  resolveContextMeter,
  windowFromModelLog,
  type ToolCall,
} from "../derive";
import { fullArgsForPid } from "../tasknames";
import type { BifrostConfig } from "../config";
import {
  type IndexEntry,
  boundedParse,
  loadIndex,
  nameFor,
  rankDeadCandidates,
  resolveDuplicate,
  saveIndex,
  slugFromCwd,
} from "./sessionIndex";
import { pinnedSessions } from "../sessions/pins";
import { pinnedToRescue } from "../sessions/pinBypass";

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
  /** Rolling command -> description index for naming child processes. */
  callIndex?: Map<string, string>;
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
  customTitle?: string;
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
  calls?: ToolCall[]; // every described tool call in the window, open or done
  customTitle?: string; // last user-set session name seen in the window
  setWindow?: number; // window from the last "/model" switch seen in the window
  nowDoing?: string;
  lastPromptAt?: number;
}

interface TranscriptCacheEntry {
  mtimeMs: number;
  size: number;
  head: TranscriptHead | null; // immutable once parsed
  tail: TranscriptTail;
}

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 128 * 1024;
// Cheap-pass header read: cwd + customTitle sit in the first JSONL lines, well
// inside this — far smaller than the deep parse's HEAD_BYTES.
const INDEX_HEAD_BYTES = 16 * 1024;
const FULL_SWEEP_MS = 30_000;

// sessionId -> materialized index entry {path, mtimeMs, size, slug, cwd, name}.
// Seeded from the persisted index on boot, refreshed incrementally by the full
// sweep (only new/mtime-changed files get a cheap header read); live sessions'
// entries are re-stat'd every tick. Dead transcripts don't change between sweeps.
let fileIndex = new Map<string, IndexEntry>();
let indexLoaded = false;
let lastFullSweep = 0;

const transcriptCache = new Map<string, TranscriptCacheEntry>();

// pid -> last CPU sample, for "is this process actually computing" detection.
const cpuTrack = new Map<number, { jiffies: number; quietSince: number }>();

// Rolling per-session naming state. The call index accumulates command ->
// description across ticks (and subagent sidechains), so a process whose
// tool call scrolled out of the tail window — or finished — keeps its name.
const CALL_INDEX_MAX = 300;
const SIDECHAIN_FRESH_MS = 30 * 60_000;
const SIDECHAIN_TAIL_BYTES = 64 * 1024;
const callIndexBySession = new Map<string, Map<string, string>>();
const titleBySession = new Map<string, string>();
const sidechainSeen = new Map<string, number>(); // agent file path -> parsed mtime
// sessionId -> window from the last "/model" switch (sticky — survives the tail window).
const modelLogBySession = new Map<string, number>();
const fullScanned = new Set<string>();

/**
 * One-time whole-transcript pass per live session: the last /model switch
 * (and a custom title) can sit mid-file, outside both head and tail windows
 * — e.g. after a collector restart. Later switches land in the tail and
 * overwrite. Mirrors tools/context-meter.py tier 1.
 */
async function fullScanOnce(sessionId: string, path: string): Promise<void> {
  if (fullScanned.has(sessionId)) return;
  fullScanned.add(sessionId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return;
  }
  let setWindow: number | undefined;
  let title: string | undefined;
  for (const line of raw.split("\n")) {
    if (line.includes("local-command-stdout") && line.includes("Set model to")) {
      try {
        const d = JSON.parse(line);
        const content = d?.message?.content;
        if (d?.type !== "user" || d?.message?.role !== "user") continue;
        // tool_results can quote stdout blocks — only plain user entries count
        if (
          Array.isArray(content) &&
          content.some((c: any) => c?.type === "tool_result")
        ) {
          continue;
        }
        const text = typeof content === "string" ? content : extractText(content);
        if (text?.includes("local-command-stdout")) {
          setWindow = windowFromModelLog(text) ?? setWindow;
        }
      } catch {
        // partial line
      }
    } else if (line.includes('"custom-title"')) {
      try {
        const d = JSON.parse(line);
        if (d?.type === "custom-title" && typeof d.customTitle === "string") {
          title = d.customTitle;
        }
      } catch {
        // partial line
      }
    }
  }
  if (setWindow && !modelLogBySession.has(sessionId)) {
    modelLogBySession.set(sessionId, setWindow);
  }
  if (title && !titleBySession.has(sessionId)) {
    titleBySession.set(sessionId, title);
  }
}

// ~/.claude.json (sits next to claudeDir): projects[cwd].lastModelUsage keys,
// mtime-cached — tier 3 of the window resolution.
let claudeJsonCache: { mtimeMs: number; projects: Record<string, string[]> } | null =
  null;

async function projectModelsFor(
  claudeDir: string,
  cwd: string,
): Promise<string[] | undefined> {
  const path = claudeDir.replace(/\/$/, "") + ".json";
  try {
    const st = await stat(path);
    if (!claudeJsonCache || claudeJsonCache.mtimeMs !== st.mtimeMs) {
      const d = JSON.parse(await readFile(path, "utf8"));
      const projects: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(d.projects ?? {})) {
        projects[k] = Object.keys((v as any)?.lastModelUsage ?? {});
      }
      claudeJsonCache = { mtimeMs: st.mtimeMs, projects };
    }
    return claudeJsonCache.projects[cwd];
  } catch {
    return undefined;
  }
}

// The user's saved-default model — the "/model … saved as your default for new
// sessions" event a bare-launch session inherits (no /model this session, no
// --model flag). It's logged in whatever session ran /model, possibly a
// different one, so we scan across all projects' transcripts (newest files
// first, stopping once no older file could hold a newer event) and cache the
// result — the default changes rarely. windowSrc "saved-default".
interface DefaultEvent {
  ts: number;
  window: number;
}
let defaultCache: { at: number; events: DefaultEvent[] } | null = null;
// per-file events keyed by mtime: the cold scan reads everything newer than the
// most-recent default once; after that only changed (active) files are re-read.
const defaultFileCache = new Map<string, { mtimeMs: number; events: DefaultEvent[] }>();
const DEFAULT_TTL_MS = 60_000;

async function scanFileForDefaults(path: string): Promise<DefaultEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  if (!raw.includes("saved as your default")) return []; // cheap reject (most files)
  const out: DefaultEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.includes("saved as your default") || !line.includes("local-command-stdout")) {
      continue;
    }
    try {
      const d = JSON.parse(line);
      if (d?.type !== "user" || d?.message?.role !== "user") continue;
      const content = d?.message?.content;
      if (Array.isArray(content) && content.some((c: any) => c?.type === "tool_result")) {
        continue; // tool_results can quote stdout — only real user entries count
      }
      const text = typeof content === "string" ? content : extractText(content);
      if (!text?.includes("local-command-stdout")) continue;
      const window = windowFromModelLog(text);
      const ts = Date.parse(d?.timestamp ?? "");
      if (window && Number.isFinite(ts)) out.push({ ts, window });
    } catch {
      /* partial line */
    }
  }
  return out;
}

/**
 * Saved-default events, sourced from the materialized index instead of a second
 * sequential stat-all walk (AC1.5). The full sweep has already collected
 * `{path, mtimeMs}` for every non-agent transcript into `fileIndex`; reuse it
 * (newest-first, stopping once no older file could carry a newer event). Each
 * file's parsed events are mtime-cached, so only changed files are re-read.
 */
async function savedDefaultEvents(
  files: { path: string; mtimeMs: number }[],
  now: number,
): Promise<DefaultEvent[]> {
  if (defaultCache && now - defaultCache.at < DEFAULT_TTL_MS) return defaultCache.events;
  files = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const events: DefaultEvent[] = [];
  let newestTs = 0;
  for (const f of files) {
    if (f.mtimeMs < newestTs) break; // sorted desc: nothing older can be newer
    const cached = defaultFileCache.get(f.path);
    const evs =
      cached && cached.mtimeMs === f.mtimeMs ? cached.events : await scanFileForDefaults(f.path);
    if (!cached || cached.mtimeMs !== f.mtimeMs) {
      defaultFileCache.set(f.path, { mtimeMs: f.mtimeMs, events: evs });
    }
    for (const e of evs) {
      events.push(e);
      if (e.ts > newestTs) newestTs = e.ts;
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  defaultCache = { at: now, events };
  return events;
}

/** The saved default a session starting at `startedAt` inherited — the latest
 *  default set at or before it. Unknown start → the most recent default. */
function savedDefaultFor(events: DefaultEvent[], startedAt?: number): number | undefined {
  if (!events.length) return undefined;
  if (startedAt === undefined) return events[events.length - 1].window;
  let win: number | undefined;
  for (const e of events) {
    if (e.ts > startedAt) break; // events sorted ascending
    win = e.window;
  }
  return win; // undefined if the session predates every recorded default
}

function mergeCalls(sessionId: string, calls: ToolCall[] | undefined): void {
  if (!calls?.length) return;
  let idx = callIndexBySession.get(sessionId);
  if (!idx) callIndexBySession.set(sessionId, (idx = new Map()));
  for (const c of calls) {
    if (!c.command || !c.description) continue;
    const key = canonCommand(c.command);
    if (key.length < 8) continue; // too generic to ever match safely
    idx.delete(key); // re-insert so map order tracks recency
    idx.set(key, c.description);
  }
  while (idx.size > CALL_INDEX_MAX) {
    idx.delete(idx.keys().next().value!);
  }
}

/**
 * Subagent tool calls live in <project>/<sessionId>/subagents/agent-*.jsonl,
 * not in the main transcript — without this, anything a subagent spawns shows
 * raw command text. Tails freshly-modified files once per mtime.
 */
async function scanSidechains(
  sessionId: string,
  transcriptPath: string,
): Promise<void> {
  const dir = join(dirname(transcriptPath), sessionId, "subagents");
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    return; // no subagents for this session
  }
  const now = Date.now();
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const path = join(dir, f);
    try {
      const st = await stat(path);
      if (now - st.mtimeMs > SIDECHAIN_FRESH_MS) continue;
      if (sidechainSeen.get(path) === st.mtimeMs) continue;
      sidechainSeen.set(path, st.mtimeMs);
      const start = Math.max(0, st.size - SIDECHAIN_TAIL_BYTES);
      const tail = parseTail(await readChunk(path, start, SIDECHAIN_TAIL_BYTES));
      mergeCalls(sessionId, tail.calls);
    } catch {
      // file vanished mid-scan
    }
  }
}

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

export function isHeadless(entrypoint?: string): boolean | undefined {
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

export function parseHead(chunk: string, fileSessionId: string): TranscriptHead | null {
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
    if (d.type === "custom-title" && typeof d.customTitle === "string") {
      head.customTitle = d.customTitle;
    }
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

export function parseTail(chunk: string): TranscriptTail {
  const tail: TranscriptTail = { openTools: 0 };
  const toolUses = new Set<string>();
  const toolResults = new Set<string>();
  const calls: ToolCall[] = [];
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
    if (d.type === "custom-title" && typeof d.customTitle === "string") {
      tail.customTitle = d.customTitle;
    }
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
          if (typeof c.input?.description === "string") {
            // every described call, open or done — a process can outlive
            // its tool call (daemons, &-backgrounded work)
            calls.push({
              command:
                typeof c.input.command === "string" ? c.input.command : undefined,
              description: c.input.description,
            });
          }
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
        if (d.timestamp) tail.lastPromptAt = Date.parse(d.timestamp);
        // "/model" switches announce themselves in command stdout. Only trust
        // plain user entries carrying the stdout marker — tool_results and
        // assistant prose can QUOTE these lines (seen live 2026-06-11).
        const text = typeof content === "string" ? content : extractText(content);
        if (text?.includes("local-command-stdout")) {
          tail.setWindow = windowFromModelLog(text) ?? tail.setWindow;
        }
      }
    }
  }
  tail.openTools = [...toolUses].filter((id) => !toolResults.has(id)).length;
  tail.calls = calls;
  return tail;
}

/** Parse (or reuse cached parse of) a transcript, given an already-known index entry. */
async function scanTranscript(
  st: IndexEntry,
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

/** Cheap index pass: read a small header chunk and extract `{cwd, name}` for the
 *  persisted index. Returns null for sidechain/agent transcripts (excluded) or a
 *  header that yielded no cwd/title. Far cheaper than the deep head+tail parse. */
async function cheapIndexHead(
  path: string,
  sessionId: string,
): Promise<{ cwd: string; name: string } | null> {
  let head: TranscriptHead | null;
  try {
    head = parseHead(await readChunk(path, 0, INDEX_HEAD_BYTES), sessionId);
  } catch {
    return null; // file vanished mid-read
  }
  if (!head || head.sidechain) return null;
  const cwd = head.cwd ?? "";
  return { cwd, name: nameFor(head.customTitle, cwd) };
}

/**
 * Re-index every transcript on disk (slow cadence). Stat-only ranking, then a
 * cheap header read ONLY for files new or mtime-changed since the last sweep —
 * a warm start re-reads nothing unchanged (AC1.3). Two transcripts sharing a
 * sessionId across slug dirs resolve deterministically with one warning (AC1.4).
 */
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
  // Stat-only ranking pass (no parse), in parallel.
  const stats: { path: string; slug: string; sessionId: string; mtimeMs: number; size: number }[] =
    [];
  await Promise.all(
    paths.map(async (path) => {
      try {
        const st = await stat(path);
        stats.push({
          path,
          slug: basename(dirname(path)),
          sessionId: basename(path, ".jsonl"),
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      } catch {
        // file vanished mid-scan
      }
    }),
  );

  // Resolve duplicate sessionIds across slug dirs deterministically (AC1.4),
  // warning once per collision so the list never flickers across sweeps.
  const next = new Map<string, IndexEntry>();
  const collided = new Set<string>();
  await Promise.all(
    stats.map(async (s) => {
      const prev = fileIndex.get(s.sessionId);
      // Reuse the cached cwd/name when the same path is unchanged; otherwise
      // (new file, grown file, or moved across slugs) do the cheap header read.
      let cwd: string;
      let name: string;
      if (prev && prev.path === s.path && prev.mtimeMs === s.mtimeMs) {
        cwd = prev.cwd;
        name = prev.name;
      } else {
        const cheap = await cheapIndexHead(s.path, s.sessionId);
        if (!cheap) return; // sidechain / vanished — not indexed
        cwd = cheap.cwd;
        name = cheap.name;
      }
      const entry: IndexEntry = {
        sessionId: s.sessionId,
        path: s.path,
        slug: s.slug,
        mtimeMs: s.mtimeMs,
        size: s.size,
        cwd,
        name,
      };
      const existing = next.get(s.sessionId);
      if (!existing) {
        next.set(s.sessionId, entry);
      } else {
        collided.add(s.sessionId);
        next.set(s.sessionId, resolveDuplicate(existing, entry));
      }
    }),
  );
  for (const sessionId of collided) {
    const winner = next.get(sessionId);
    const losers = stats.filter(
      (s) => s.sessionId === sessionId && s.path !== winner?.path,
    );
    console.warn(
      `[bifrost] duplicate sessionId ${sessionId} across slug dirs — using ${winner?.path}; ignoring ${losers
        .map((l) => l.path)
        .join(", ")}`,
    );
  }

  fileIndex = next;
  // Drop parse-cache entries for files that no longer exist.
  const livePaths = new Set([...next.values()].map((f) => f.path));
  for (const path of transcriptCache.keys()) {
    if (!livePaths.has(path)) transcriptCache.delete(path);
  }
  // Persist the refreshed index so a warm start reloads it (AC1.3).
  try {
    await saveIndex(fileIndex);
  } catch {
    // best-effort cache; the next sweep rebuilds it
  }
}

interface LiveExtras {
  cpuQuietMs: number;
  printMode: boolean;
  launchModel?: string;
}

async function collectLive(
  claudeDir: string,
): Promise<Map<string, LivePidFile & LiveExtras>> {
  const live = new Map<string, LivePidFile & LiveExtras>();
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
      const args = fullArgsForPid(d.pid);
      live.set(d.sessionId, {
        ...d,
        cpuQuietMs: trackCpu(d.pid, proc.jiffies, now),
        // pid files of desktop-spawned background agents claim
        // kind=interactive — the cmdline is the honest signal
        printMode: isPrintCmdline(args),
        launchModel: launchModelFromCmdline(args),
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
  cfg: BifrostConfig,
): Promise<SessionsResult> {
  const live = await collectLive(cfg.claudeDir);
  const scratch = cfg.summarize.scratchDir;
  // Bifrost's own summarizer sessions never appear in the dashboard.
  for (const [sid, lp] of live) {
    if (lp.cwd === scratch || lp.cwd.startsWith(scratch + "/")) live.delete(sid);
  }

  // Warm start: reload the persisted index so unchanged files aren't re-parsed
  // before the first sweep runs (AC1.3).
  if (!indexLoaded) {
    indexLoaded = true;
    try {
      fileIndex = await loadIndex();
    } catch {
      // no persisted index yet — the first sweep builds it
    }
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
          slugFromCwd(lp.cwd),
          `${lp.sessionId}.jsonl`,
        );
      try {
        const st = await stat(path);
        fileIndex.set(lp.sessionId, {
          sessionId: lp.sessionId,
          path,
          slug: basename(dirname(path)),
          mtimeMs: st.mtimeMs,
          size: st.size,
          // keep the indexed cwd/name; fall back to the live cwd for a session
          // not yet in the index (cheap pass hasn't seen it).
          cwd: known?.cwd ?? lp.cwd,
          name: known?.name ?? nameFor(undefined, lp.cwd),
        });
      } catch {
        // transcript not on disk yet
      }
    }),
  );

  const cutoff = now - cfg.sessions.historyDays * 86_400_000;
  const pinned = await pinnedSessions();
  const seen = new Set<string>();
  const signals = new Map<string, SessionSignals>();
  const defaultEvents = await savedDefaultEvents(
    [...fileIndex.values()].map((e) => ({ path: e.path, mtimeMs: e.mtimeMs })),
    now,
  );

  // Build a SessionInfo from a deep-parsed transcript. Shared by the live and
  // bounded-dead passes; returns null when the entry is unparseable, a
  // sidechain, or a scratch-cwd Bifrost session (excluded everywhere).
  const buildRow = async (fs: IndexEntry): Promise<SessionInfo | null> => {
    const sessionId = fs.sessionId;
    const lp = live.get(sessionId);
    const entry = await scanTranscript(fs);
    if (!entry || !entry.head || entry.head.sidechain) return null;
    const cwd = lp?.cwd ?? entry.head.cwd ?? "";
    if (cwd === scratch || cwd.startsWith(scratch + "/")) return null;
    seen.add(sessionId);
    const seenTitle = entry.tail.customTitle ?? entry.head?.customTitle;
    if (seenTitle) titleBySession.set(sessionId, seenTitle);
    let meter;
    if (lp) {
      await fullScanOnce(sessionId, fs.path);
      if (entry.tail.setWindow) modelLogBySession.set(sessionId, entry.tail.setWindow);
      meter = resolveContextMeter({
        setWindow: modelLogBySession.get(sessionId),
        launchModel: lp.launchModel,
        savedDefault: savedDefaultFor(defaultEvents, lp.startedAt ?? entry.head.startedAt),
        msgModel: entry.tail.model,
        projectModels: await projectModelsFor(cfg.claudeDir, cwd),
        tokens: entry.tail.contextTokens,
      });
      mergeCalls(sessionId, entry.tail.calls);
      await scanSidechains(sessionId, fs.path);
      signals.set(sessionId, {
        lastEntry: entry.tail.lastEntry,
        openTools: entry.tail.openTools,
        callIndex: callIndexBySession.get(sessionId),
        cpuQuietMs: lp.cpuQuietMs,
        pidStatus: lp.status,
        pidStatusAgeMs: lp.statusUpdatedAt ? now - lp.statusUpdatedAt : undefined,
        kind: lp.kind,
      });
    }
    return {
      sessionId,
      pid: lp?.pid,
      live: !!lp,
      kind: lp?.kind,
      status: lp?.status,
      entrypoint: lp?.entrypoint ?? entry.head.entrypoint,
      headless:
        lp?.printMode || isHeadless(lp?.entrypoint ?? entry.head.entrypoint),
      cwd: lp?.cwd ?? entry.head.cwd ?? "",
      title: entry.head.title,
      customTitle: titleBySession.get(sessionId),
      gitBranch: entry.head.gitBranch,
      model: meter?.model ?? entry.tail.model,
      contextWindow: meter?.window,
      contextWindowSrc: meter?.windowSrc,
      startedAt: lp?.startedAt ?? entry.head.startedAt,
      lastActivityAt: entry.tail.lastTimestamp ?? fs.mtimeMs,
      contextTokens: entry.tail.contextTokens,
      transcriptBytes: fs.size,
      nowDoing: lp ? entry.tail.nowDoing : undefined,
      lastPromptAt: lp ? entry.tail.lastPromptAt : undefined,
    };
  };

  // Always deep-parse live sessions.
  const liveRowsRaw: SessionInfo[] = [];
  for (const sessionId of live.keys()) {
    const fs = fileIndex.get(sessionId);
    if (!fs) continue;
    const row = await buildRow(fs);
    if (row) liveRowsRaw.push(row);
  }

  // Dead candidates: ranked newest-first, parsed only until `maxHistory`
  // eligible interactive rows accumulate (AC1.1) — not the whole pile.
  const ranked = rankDeadCandidates(fileIndex.values(), new Set(live.keys()), cutoff);
  const { rows: deadRows } = await boundedParse(
    ranked,
    cfg.sessions.maxHistory,
    buildRow,
    (row) => !row.headless,
  );

  const out: SessionInfo[] = [...liveRowsRaw, ...deadRows];

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
      headless: lp.printMode || isHeadless(lp.entrypoint),
      cwd: lp.cwd,
      startedAt: lp.startedAt,
      lastActivityAt: lp.startedAt,
    });
  }

  const liveRows = out
    .filter((s) => s.live)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  // Interactive history gets the cap; headless corpses only fill what's left,
  // so probe swarms can't bury real sessions.
  const dead = out
    .filter((s) => !s.live)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const deadInteractive = dead
    .filter((s) => !s.headless)
    .slice(0, cfg.sessions.maxHistory);
  const deadHeadless = dead
    .filter((s) => s.headless)
    .slice(0, Math.max(0, cfg.sessions.maxHistory - deadInteractive.length));
  const history = [...deadInteractive, ...deadHeadless].sort(
    (a, b) => b.lastActivityAt - a.lastActivityAt,
  );
  // Pin rescue (AC2.3 / red-team M1): a pinned session must render even when a
  // cutoff dropped it — older than historyDays (never ranked into the bounded
  // parse) OR sliced off past maxHistory. Pull the pinned-but-absent ids back
  // from the full uncapped index and deep-parse them now (a tiny set — the pin
  // count, not the pile). Bypasses BOTH cutoffs by consulting neither.
  const boundedIds = new Set([
    ...liveRows.map((s) => s.sessionId),
    ...history.map((s) => s.sessionId),
  ]);
  const rescued: SessionInfo[] = [];
  for (const e of pinnedToRescue(
    fileIndex.values(),
    pinned,
    boundedIds,
    new Set(live.keys()),
  )) {
    const row = await buildRow(e);
    if (row) rescued.push(row);
  }
  const historyWithPins = [...history, ...rescued].sort(
    (a, b) => b.lastActivityAt - a.lastActivityAt,
  );
  // Stamp the Bifrost-owned pin flag onto every row the dashboard will show.
  for (const s of [...liveRows, ...historyWithPins]) {
    if (pinned.has(s.sessionId)) s.pinned = true;
  }
  // Naming state only matters while a session lives; titles stay sticky
  // for any transcript still indexed.
  for (const sid of callIndexBySession.keys()) {
    if (!live.has(sid)) callIndexBySession.delete(sid);
  }
  for (const sid of fullScanned) {
    if (!live.has(sid)) {
      fullScanned.delete(sid);
      modelLogBySession.delete(sid);
    }
  }
  for (const sid of titleBySession.keys()) {
    if (!fileIndex.has(sid)) titleBySession.delete(sid);
  }
  const staleMtime = Date.now() - SIDECHAIN_FRESH_MS;
  for (const [path, mtime] of sidechainSeen) {
    if (mtime < staleMtime) sidechainSeen.delete(path);
  }
  const livePids = new Map<string, number>();
  for (const [sid, lp] of live) livePids.set(sid, lp.pid);
  return { sessions: [...liveRows, ...historyWithPins], signals, livePids };
}

/** Transcript path for a known session id, if indexed. */
export function transcriptPathFor(sessionId: string): string | undefined {
  return fileIndex.get(sessionId)?.path;
}

/** Latest known mtime for a session's transcript. */
export function transcriptMtimeFor(sessionId: string): number | undefined {
  return fileIndex.get(sessionId)?.mtimeMs;
}

/**
 * The full *uncapped* session index as `SessionIndexEntry` rows (story 2-2,
 * AC2.2). The dashboard snapshot is capped at `maxHistory`; the name-search box
 * needs the whole pile, so this ships once and the matcher runs client-side per
 * keystroke (no network round-trip). `liveIds` (the current live set from the
 * snapshot) marks which rows are tmux-resident — a live row routes to the drive
 * view rather than a view-only open. Only the fields a name search + a
 * click-through need; never the deep-parsed transcript.
 */
export function sessionIndexEntries(
  liveIds: ReadonlySet<string>,
): import("../../shared/types").SessionIndexEntry[] {
  const out: import("../../shared/types").SessionIndexEntry[] = [];
  for (const e of fileIndex.values()) {
    // `e.name` is already `customTitle ?? basename(cwd)` (story 2-1 AC1.2). Ship
    // it as `customTitle` so the client matcher (`sessionName`) reads the same
    // searchable name; when the session was never renamed it equals basename(cwd)
    // and the match is identical either way.
    out.push({
      sessionId: e.sessionId,
      cwd: e.cwd,
      customTitle: e.name || undefined,
      mtimeMs: e.mtimeMs,
      live: liveIds.has(e.sessionId),
    });
  }
  return out;
}
