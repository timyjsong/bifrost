import { mkdirSync, existsSync } from "node:fs";
import { readFile, writeFile, readdir, stat, open } from "node:fs/promises";
import { join } from "node:path";
import type { AtriumConfig } from "./config";
import { transcriptPathFor, transcriptMtimeFor } from "./collectors/sessions";

export interface SummaryResult {
  summary: string;
  asOf: number; // source transcript mtime the summary reflects
  cached: boolean;
}

const inFlight = new Map<string, Promise<SummaryResult>>();

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
async function extractConversation(path: string): Promise<string> {
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
  cfg: AtriumConfig,
  shortId: string,
): Promise<string> {
  const slug = cfg.summarize.scratchDir.replace(/[/.]/g, "-");
  const dir = join(cfg.claudeDir, "projects", slug);
  const deadline = Date.now() + cfg.summarize.timeoutMs;
  let path: string | undefined;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
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
  cfg: AtriumConfig,
  sessionId: string,
  sourcePath: string,
  sourceMtime: number,
): Promise<SummaryResult> {
  const convo = await extractConversation(sourcePath);
  if (!convo.trim()) throw new Error("transcript has no conversation to summarize");

  const prompt =
    "You are summarizing one of the user's own Claude Code working sessions back to them. " +
    "Write a concise, plain-English summary: 4-8 short bullet points covering what was asked for, " +
    "what got done, key decisions made, and what (if anything) the session is currently waiting on. " +
    "No preamble, no headings — just the bullets. Do not use any tools.\n\n" +
    `<session-transcript>\n${convo}\n</session-transcript>`;

  mkdirSync(cfg.summarize.scratchDir, { recursive: true });
  const proc = Bun.spawn(
    [cfg.summarize.claudeBin, "--bg", "--model", cfg.summarize.model, prompt],
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
    JSON.stringify({ sourceMtimeMs: sourceMtime, summary, createdAt: Date.now() }),
  );
  return result;
}

export async function summarizeSession(
  cfg: AtriumConfig,
  sessionId: string,
): Promise<SummaryResult> {
  const sourcePath = transcriptPathFor(sessionId);
  const sourceMtime = transcriptMtimeFor(sessionId);
  if (!sourcePath || sourceMtime === undefined) {
    throw new Error("unknown session");
  }

  // serve cache when the source hasn't moved
  const cachePath = join(cfg.summarize.cacheDir, `${sessionId}.json`);
  if (existsSync(cachePath)) {
    try {
      const c = JSON.parse(await readFile(cachePath, "utf8"));
      if (c.sourceMtimeMs === sourceMtime && c.summary) {
        return { summary: c.summary, asOf: c.sourceMtimeMs, cached: true };
      }
    } catch {
      // corrupt cache — fall through to regenerate
    }
  }

  const existing = inFlight.get(sessionId);
  if (existing) return existing;
  if (inFlight.size >= cfg.summarize.maxInFlight) {
    throw new Error("summarizer busy — try again in a moment");
  }
  const p = runSummarize(cfg, sessionId, sourcePath, sourceMtime).finally(() =>
    inFlight.delete(sessionId),
  );
  inFlight.set(sessionId, p);
  return p;
}
