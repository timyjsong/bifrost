import { readFileSync, existsSync } from "node:fs";
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

interface TranscriptCacheEntry {
  mtimeMs: number;
  size: number;
  head: TranscriptHead | null; // immutable once parsed
  tail: TranscriptTail;
}

const transcriptCache = new Map<string, TranscriptCacheEntry>();

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 128 * 1024;

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

async function scanTranscript(path: string): Promise<TranscriptCacheEntry | null> {
  let st;
  try {
    st = await stat(path);
  } catch {
    return null;
  }
  const cached = transcriptCache.get(path);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached;
  }
  const sessionId = basename(path, ".jsonl");
  const head =
    cached?.head ?? parseHead(await readChunk(path, 0, HEAD_BYTES), sessionId);
  const tailStart = Math.max(0, st.size - TAIL_BYTES);
  const tail = parseTail(await readChunk(path, tailStart, TAIL_BYTES));
  const entry: TranscriptCacheEntry = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    head,
    tail,
  };
  transcriptCache.set(path, entry);
  return entry;
}

async function collectLive(claudeDir: string): Promise<Map<string, LivePidFile>> {
  const live = new Map<string, LivePidFile>();
  const dir = join(claudeDir, "sessions");
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    return live;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(readFileSync(join(dir, f), "utf8")) as LivePidFile;
      if (d.pid && d.sessionId && procAlive(d.pid, d.procStart)) {
        live.set(d.sessionId, d);
      }
    } catch {
      // unreadable/partial pid file — treat as not live
    }
  }
  return live;
}

export async function collectSessions(
  cfg: AtriumConfig,
): Promise<SessionInfo[]> {
  const live = await collectLive(cfg.claudeDir);

  const projectsDir = join(cfg.claudeDir, "projects");
  const transcripts: { path: string; mtimeMs: number }[] = [];
  let slugs: string[] = [];
  try {
    slugs = await readdir(projectsDir);
  } catch {
    slugs = [];
  }
  for (const slug of slugs) {
    const dir = join(projectsDir, slug);
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl") || f.startsWith("agent-")) continue;
      const p = join(dir, f);
      try {
        const st = await stat(p);
        transcripts.push({ path: p, mtimeMs: st.mtimeMs });
      } catch {
        // file vanished mid-scan
      }
    }
  }

  const cutoff = Date.now() - cfg.sessions.historyDays * 86_400_000;
  const seen = new Set<string>();
  const out: SessionInfo[] = [];

  for (const t of transcripts) {
    const sessionId = basename(t.path, ".jsonl");
    const isLive = live.has(sessionId);
    if (!isLive && t.mtimeMs < cutoff) continue;
    const entry = await scanTranscript(t.path);
    if (!entry || !entry.head || entry.head.sidechain) continue;
    const lp = live.get(sessionId);
    seen.add(sessionId);
    out.push({
      sessionId,
      pid: lp?.pid,
      live: isLive,
      kind: lp?.kind,
      status: lp?.status,
      entrypoint: lp?.entrypoint ?? entry.head.entrypoint,
      headless: isHeadless(lp?.entrypoint ?? entry.head.entrypoint),
      cwd: lp?.cwd ?? entry.head.cwd ?? "",
      title: entry.head.title,
      gitBranch: entry.head.gitBranch,
      model: entry.tail.model,
      startedAt: lp?.startedAt ?? entry.head.startedAt,
      lastActivityAt: entry.tail.lastTimestamp ?? entry.mtimeMs,
      contextTokens: entry.tail.contextTokens,
      transcriptBytes: entry.size,
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
