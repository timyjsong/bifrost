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
  entrypoint?: string;
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

interface TranscriptTail {
  contextTokens?: number;
  model?: string;
  lastTimestamp?: number;
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

/** Is the pid alive, and (if procStart given) the same process that wrote the pid file? */
function procAlive(pid: number, procStart?: string): boolean {
  try {
    const statLine = readFileSync(`/proc/${pid}/stat`, "utf8");
    if (!procStart) return true;
    // comm (field 2) may contain spaces — parse fields after the closing paren.
    // After ") ", index 0 is field 3 (state), so field 22 (starttime) is index 19.
    const after = statLine.slice(statLine.lastIndexOf(")") + 2).trimStart();
    return after.split(" ")[19] === procStart;
  } catch {
    return false;
  }
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
  const tail: TranscriptTail = {};
  const lines = chunk.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!tail.lastTimestamp && d.timestamp) {
      tail.lastTimestamp = Date.parse(d.timestamp);
    }
    if (!tail.contextTokens && d.message?.usage?.input_tokens !== undefined) {
      const u = d.message.usage;
      tail.contextTokens =
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0);
      tail.model = d.message.model ?? tail.model;
    }
    if (tail.contextTokens && tail.lastTimestamp) break;
  }
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

function collectLive(claudeDir: string): Promise<Map<string, LivePidFile>> {
  return readdir(join(claudeDir, "sessions")).then(
    (files) => {
      const live = new Map<string, LivePidFile>();
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
          const d = JSON.parse(
            readFileSync(join(claudeDir, "sessions", f), "utf8"),
          ) as LivePidFile;
          if (d.pid && d.sessionId && procAlive(d.pid, d.procStart)) {
            live.set(d.sessionId, d);
          }
        } catch {
          // unreadable/partial pid file — treat as not live
        }
      }
      return live;
    },
    () => new Map(),
  );
}

export async function collectSessions(
  cfg: AtriumConfig,
): Promise<SessionInfo[]> {
  const live = await collectLive(cfg.claudeDir);

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

  for (const [sessionId, fs] of fileIndex) {
    const lp = live.get(sessionId);
    if (!lp && fs.mtimeMs < cutoff) continue;
    const entry = await scanTranscript(fs);
    if (!entry || !entry.head || entry.head.sidechain) continue;
    seen.add(sessionId);
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
    });
  }

  // Live sessions whose transcript we didn't find still deserve a row.
  for (const [sessionId, lp] of live) {
    if (seen.has(sessionId)) continue;
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
  const history = out.filter((s) => !s.live).slice(0, cfg.sessions.maxHistory);
  return [...liveRows, ...history];
}
