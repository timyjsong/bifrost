import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { readFile, writeFile, readdir, stat, open } from "node:fs/promises";
import { join } from "node:path";
import type { BifrostConfig } from "./config";
import { transcriptPathFor, transcriptMtimeFor } from "./collectors/sessions";

export interface SummaryResult {
  summary: string;
  asOf: number; // source transcript mtime the summary reflects
  cached: boolean;
}

// Bump when the prompt changes — cached summaries from older prompts regenerate.
const PROMPT_VERSION = 2;

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (c && typeof c === "object" && (c as any).type === "text") {
        const t = (c as any).text;
        if (typeof t === "string" && t.trim()) parts.push(t);
      }
    }
    if (parts.length) return parts.join("\n");
  }
  return undefined;
}

/** Condense a transcript to alternating User/Assistant text, capped in size. */
export async function extractConversation(path: string): Promise<string> {
  const raw = await readFile(path, "utf8");
  const turns: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const m = d.message;
    if (!m) continue;
    if (d.type === "user" && m.role === "user") {
      const text = extractText(m.content);
      // typed prompts only — skip tool results and harness wrappers
      if (
        text &&
        !text.startsWith("Caveat:") &&
        !text.startsWith("<") &&
        !(Array.isArray(m.content) &&
          m.content.some((c: any) => c?.type === "tool_result"))
      ) {
        turns.push(`User: ${text}`);
      }
    } else if (d.type === "assistant" && m.role === "assistant") {
      const text = extractText(m.content);
      if (text) turns.push(`Assistant: ${text}`);
    }
  }
  let convo = turns.join("\n\n");
  const CAP = 24_000;
  if (convo.length > CAP) {
    convo =
      convo.slice(0, 6_000) +
      "\n\n[... middle of session omitted for length ...]\n\n" +
      convo.slice(-(CAP - 6_000));
  }
  return convo;
}

/** Wait for the dispatched bg session to finish and return its final text. */
async function awaitBgResult(
  cfg: BifrostConfig,
  shortId: string,
): Promise<string> {
  const slug = cfg.summarize.scratchDir.replace(/[/.]/g, "-");
  const dir = join(cfg.claudeDir, "projects", slug);
  const deadline = Date.now() + cfg.summarize.timeoutMs;
  let path: string | undefined;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (!path) {
      try {
        const f = (await readdir(dir)).find(
          (f) => f.startsWith(shortId) && f.endsWith(".jsonl"),
        );
        if (f) path = join(dir, f);
      } catch {
        continue; // slug dir not created yet
      }
      if (!path) continue;
    }
    // read the tail; finished when the last assistant turn ended with text
    let chunk: string;
    try {
      const st = await stat(path);
      const fh = await open(path, "r");
      try {
        const len = Math.min(st.size, 256 * 1024);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, st.size - len);
        chunk = buf.toString("utf8");
      } finally {
        await fh.close();
      }
    } catch {
      continue;
    }
    let lastText: string | undefined;
    let done = false;
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        const m = d.message;
        if (d.type === "assistant" && m?.role === "assistant") {
          const t = extractText(m.content);
          if (t) lastText = t;
          if (m.stop_reason === "end_turn") done = true;
          else if (m.stop_reason) done = false;
        } else if (d.type === "user") {
          done = false;
        }
      } catch {
        // partial line
      }
    }
    if (done && lastText) return lastText;
  }
  // give up; try to stop the runaway session
  Bun.spawn([cfg.summarize.claudeBin, "stop", shortId], {
    stdout: "ignore",
    stderr: "ignore",
  });
  throw new Error("summarizer timed out");
}

async function runSummarize(
  cfg: BifrostConfig,
  sessionId: string,
  sourcePath: string,
  sourceMtime: number,
): Promise<SummaryResult> {
  const convo = await extractConversation(sourcePath);
  if (!convo.trim()) throw new Error("transcript has no conversation to summarize");

  const prompt =
    "You are summarizing one of the user's own Claude Code working sessions back to them. " +
    "Write 4-8 markdown bullet points covering: what was asked for, what got done, key decisions, " +
    "and what (if anything) the session is waiting on now. Rules: each bullet is exactly ONE short, " +
    "plain sentence on its own line; you may bold the 2-3 most important phrases; no headings, " +
    "no preamble, no nested bullets. Do not use any tools.\n\n" +
    `<session-transcript>\n${convo}\n</session-transcript>`;

  mkdirSync(cfg.summarize.scratchDir, { recursive: true });
  const proc = Bun.spawn(
    [
      cfg.summarize.claudeBin,
      "--bg",
      "--model",
      cfg.summarize.model,
      "--effort",
      cfg.summarize.effort,
      ...cfg.summarize.fastStartArgs,
      prompt,
    ],
    { cwd: cfg.summarize.scratchDir, stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const shortId = out.match(/backgrounded\s*·\s*([0-9a-f]+)/)?.[1];
  if (!shortId) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`bg dispatch failed: ${(out + err).slice(0, 200)}`);
  }

  const summary = await awaitBgResult(cfg, shortId);

  // tidy the agents list; ignore failures
  Bun.spawn([cfg.summarize.claudeBin, "rm", shortId], {
    stdout: "ignore",
    stderr: "ignore",
  });

  const result: SummaryResult = { summary, asOf: sourceMtime, cached: false };
  mkdirSync(cfg.summarize.cacheDir, { recursive: true });
  await writeFile(
    join(cfg.summarize.cacheDir, `${sessionId}.json`),
    JSON.stringify({
      sourceMtimeMs: sourceMtime,
      summary,
      createdAt: Date.now(),
      promptV: PROMPT_VERSION,
    }),
  );
  return result;
}

// ---- queue --------------------------------------------------------------
// Clicks past maxInFlight queue (FIFO) instead of blocking. A memory floor
// holds dispatch when the box is tight, and a depth cap protects Bifrost's own
// runtime from unbounded pile-up. Per-session dedupe: one job per session.

interface Pending {
  promise: Promise<SummaryResult>;
  resolve: (r: SummaryResult) => void;
  reject: (e: unknown) => void;
}

const inFlight = new Map<string, Promise<SummaryResult>>();
const queued = new Map<string, Pending>();
const order: string[] = []; // FIFO of queued session ids
let pumpTimer: ReturnType<typeof setTimeout> | null = null;

// Test seams — production uses the real implementations; tests inject fakes
// so queue mechanics are exercised without spawning claude or reading /proc.
let memInfoImpl: () => { totalMb: number; availMb: number };
let jobRunner: (cfg: BifrostConfig, sessionId: string) => Promise<SummaryResult>;
let sourceLookup: {
  path: (id: string) => string | undefined;
  mtime: (id: string) => number | undefined;
};
export function _setTestSeams(seams: {
  mem?: typeof memInfoImpl;
  job?: typeof jobRunner;
  lookup?: typeof sourceLookup;
}): void {
  if (seams.mem) memInfoImpl = seams.mem;
  if (seams.job) jobRunner = seams.job;
  if (seams.lookup) sourceLookup = seams.lookup;
}

/** Test-only: clear all queue state so tests are isolated. */
export function _resetQueueForTest(): void {
  inFlight.clear();
  queued.clear();
  order.length = 0;
  if (pumpTimer) {
    clearTimeout(pumpTimer);
    pumpTimer = null;
  }
}

/** Live box memory in MB from /proc/meminfo. Read each dispatch so the limits
 *  track the actual hardware — upsize or downsize the box and they follow,
 *  no config edit needed. */
function memInfo(): { totalMb: number; availMb: number } {
  try {
    const raw = readFileSync("/proc/meminfo", "utf8");
    const total = Number(raw.match(/MemTotal:\s+(\d+)/)?.[1] ?? 0) / 1024;
    const avail = Number(raw.match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0) / 1024;
    return { totalMb: Math.round(total), availMb: Math.round(avail) };
  } catch {
    return { totalMb: 0, availMb: Number.MAX_SAFE_INTEGER };
  }
}
memInfoImpl = memInfo;

/** The unit's MemoryMax does not change while the process runs, so read it once. */
const cgroupCeilingMb = readOwnCgroupMaxMb();

/**
 * Read the memory ceiling of the cgroup THIS process runs in, in MB.
 *
 * Summarize jobs are plain `Bun.spawn` children, so they stay inside the
 * service's own cgroup — which means the unit's `MemoryMax`, not the size of the
 * box, is what actually bounds them. Returns null when there is no ceiling
 * (`max`) or the files can't be read; the caller falls back to the box.
 */
export function readOwnCgroupMaxMb(
  root = "/sys/fs/cgroup",
  selfCgroup = "/proc/self/cgroup",
): number | null {
  try {
    // cgroup v2: a single `0::/the/path` line.
    const rel = readFileSync(selfCgroup, "utf8")
      .split("\n")
      .map((l) => l.match(/^0::(.*)$/)?.[1])
      .find((p) => p !== undefined);
    if (!rel) return null;
    const raw = readFileSync(join(root, rel, "memory.max"), "utf8").trim();
    if (raw === "max" || raw === "") return null; // uncapped — the box is the bound
    const bytes = Number(raw);
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    return Math.round(bytes / 1024 / 1024);
  } catch {
    return null;
  }
}

/**
 * How many summarize jobs may run at once.
 *
 * Prefers the cgroup ceiling when there is one. Deriving from total system RAM
 * was wrong in a way that stayed hidden: the jobs live in the service's cgroup,
 * so on a 23G box behind a 2G `MemoryMax` the derivation happily sized itself
 * against 23G and only `maxInFlightCap` kept it honest — a cap nothing enforced
 * any relationship with. Raise the cap (or perJobMb) without raising MemoryMax
 * and the kernel OOM-kills inside the cgroup, possibly picking Bifrost itself
 * rather than the job.
 *
 * `memReservePct` of the ceiling is held back for Bifrost's own footprint, since
 * it shares the cgroup with the jobs it spawns.
 *
 * The floor differs by basis on purpose. Against the box it is 2, so an
 * unreadable /proc/meminfo still makes progress. Against a real cgroup ceiling
 * it is 1: a ceiling too small for two jobs must yield one, because forcing a
 * second is precisely the overcommit this exists to prevent.
 */
export function deriveMaxInFlight(
  cfg: BifrostConfig,
  totalMb: number,
  cgroupMaxMb: number | null = null,
): number {
  const { perJobMb, ramShare, memReservePct, maxInFlightCap } = cfg.summarize;
  if (cgroupMaxMb && cgroupMaxMb > 0) {
    const budget = cgroupMaxMb * (1 - memReservePct);
    const derived = Math.floor(budget / perJobMb);
    return Math.max(1, Math.min(maxInFlightCap, derived));
  }
  if (!totalMb) return 2;
  const derived = Math.floor((totalMb * ramShare) / perJobMb);
  return Math.max(2, Math.min(maxInFlightCap, derived));
}

/** Live view of the queue, for the snapshot. */
export function summarizeState(): { active: string[]; queued: string[] } {
  return { active: [...inFlight.keys()], queued: [...order] };
}

/**
 * Derived limits — for the startup log.
 *
 * There are TWO guards and they answer different questions, so the log reports
 * both rather than blending them:
 *
 *  - `maxInFlight` — how many jobs fit in the cgroup this service runs in.
 *    `basis` says whether that ceiling or the box's RAM decided it.
 *  - `reserveMb` — the free-memory floor `pump` holds the queue at. That gate
 *    is about the whole box being under pressure, not about the cgroup, so it
 *    is computed from system MemTotal. An earlier version of this function
 *    reported it against the cgroup ceiling, which made the logged number
 *    describe nothing that was actually enforced.
 */
export function summarizeLimits(cfg: BifrostConfig): {
  maxInFlight: number;
  totalMb: number;
  reserveMb: number;
  basis: "cgroup" | "system";
  cgroupMaxMb: number | null;
} {
  const { totalMb } = memInfo();
  const cgroupMaxMb = readOwnCgroupMaxMb();
  return {
    maxInFlight: deriveMaxInFlight(cfg, totalMb, cgroupMaxMb),
    totalMb,
    // Matches the `availMb < totalMb * memReservePct` check in pump() exactly.
    reserveMb: Math.round(totalMb * cfg.summarize.memReservePct),
    basis: cgroupMaxMb ? "cgroup" : "system",
    cgroupMaxMb,
  };
}

function pump(cfg: BifrostConfig) {
  if (pumpTimer) {
    clearTimeout(pumpTimer);
    pumpTimer = null;
  }
  while (order.length > 0) {
    const { totalMb, availMb } = memInfoImpl();
    if (inFlight.size >= deriveMaxInFlight(cfg, totalMb, cgroupCeilingMb)) break;
    // Hold the whole queue when free RAM dips below the reserve; retry shortly.
    // Deliberately system-wide, not cgroup-scoped: concurrency above already
    // bounds what fits in our own cgroup, whereas this is the "the box itself is
    // struggling, don't add to it" backstop. summarizeLimits reports this same
    // number so the startup log states what is actually enforced.
    if (availMb < totalMb * cfg.summarize.memReservePct) {
      pumpTimer = setTimeout(() => pump(cfg), 2500);
      return;
    }
    const sessionId = order.shift()!;
    const pending = queued.get(sessionId)!;
    queued.delete(sessionId);
    // Store the RAW job promise so late joiners get the actual result;
    // settlement and slot-recycling ride a separate chain.
    const task = jobRunner(cfg, sessionId);
    inFlight.set(sessionId, task);
    task.then(pending.resolve, pending.reject).finally(() => {
      inFlight.delete(sessionId);
      pump(cfg);
    });
  }
}

/** Resolve a session to a summary: cache hit, or a fresh bg generation. */
async function produceSummary(
  cfg: BifrostConfig,
  sessionId: string,
): Promise<SummaryResult> {
  const sourcePath = sourceLookup.path(sessionId);
  const sourceMtime = sourceLookup.mtime(sessionId);
  if (!sourcePath || sourceMtime === undefined) {
    throw new Error("unknown session");
  }
  const cached = readCache(cfg, sessionId, sourceMtime);
  if (cached) return cached;
  return runSummarize(cfg, sessionId, sourcePath, sourceMtime);
}
jobRunner = produceSummary;
sourceLookup = { path: transcriptPathFor, mtime: transcriptMtimeFor };

/** Valid cached summary for the current source mtime, or null. */
function readCache(
  cfg: BifrostConfig,
  sessionId: string,
  sourceMtime: number,
): SummaryResult | null {
  const cachePath = join(cfg.summarize.cacheDir, `${sessionId}.json`);
  if (!existsSync(cachePath)) return null;
  try {
    const c = JSON.parse(readFileSync(cachePath, "utf8"));
    if (
      c.sourceMtimeMs === sourceMtime &&
      c.summary &&
      c.promptV === PROMPT_VERSION
    ) {
      return { summary: c.summary, asOf: c.sourceMtimeMs, cached: true };
    }
  } catch {
    // corrupt cache — regenerate
  }
  return null;
}

export async function summarizeSession(
  cfg: BifrostConfig,
  sessionId: string,
): Promise<SummaryResult> {
  const sourceMtime = sourceLookup.mtime(sessionId);
  if (!sourceLookup.path(sessionId) || sourceMtime === undefined) {
    throw new Error("unknown session");
  }

  // instant path: fresh cached summary, never touches the queue
  const cached = readCache(cfg, sessionId, sourceMtime);
  if (cached) return cached;

  // dedupe: one job per session, whether running or waiting
  const running = inFlight.get(sessionId);
  if (running) return running;
  const waiting = queued.get(sessionId);
  if (waiting) return waiting.promise;

  // protect Bifrost's own runtime from unbounded pile-up
  if (inFlight.size + order.length >= cfg.summarize.maxQueue) {
    throw new Error("summarizer queue is full — try again shortly");
  }

  let resolve!: (r: SummaryResult) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<SummaryResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  queued.set(sessionId, { promise, resolve, reject });
  order.push(sessionId);
  pump(cfg);
  return promise;
}
