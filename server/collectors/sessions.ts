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

async function savedDefaultEvents(claudeDir: string, now: number): Promise<DefaultEvent[]> {
  if (defaultCache && now - defaultCache.at < DEFAULT_TTL_MS) return defaultCache.events;
  const projectsDir = join(claudeDir, "projects");
  const files: { path: string; mtimeMs: number }[] = [];
  try {
    for (const slug of await readdir(projectsDir)) {
      const dir = join(projectsDir, slug);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.endsWith(".jsonl")) continue;
        try {
          files.push({ path: join(dir, n), mtimeMs: (await stat(join(dir, n))).mtimeMs });
        } catch {
          /* vanished */
        }
      }
    }
  } catch {
    /* no projects dir */
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
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
  const defaultEvents = await savedDefaultEvents(cfg.claudeDir, now);

  for (const [sessionId, fs] of fileIndex) {
    const lp = live.get(sessionId);
    if (!lp && fs.mtimeMs < cutoff) continue;
    const entry = await scanTranscript(fs);
    if (!entry || !entry.head || entry.head.sidechain) continue;
    const cwd = lp?.cwd ?? entry.head.cwd ?? "";
    if (cwd === scratch || cwd.startsWith(scratch + "/")) continue;
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
      headless: lp.printMode || isHeadless(lp.entrypoint),
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
