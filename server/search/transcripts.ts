/**
 * Conversation search — grep-over-files across every transcript (the
 * claudecodeui-verified pattern: no index, no database; the JSONL corpus IS
 * the store). Two stages keep it bounded on a ~4.4k-file corpus:
 *   1. `grep -rilF` names candidate FILES (small output, C-fast),
 *   2. the newest N candidates are scanned in-process for a clean human
 *      snippet — the term must appear in conversation TEXT (user/assistant
 *      blocks, summaries), not merely in tool payloads' paths/ids.
 * Pure helpers are exported for tests; the grep spawn is injectable.
 */
import { statSync } from "node:fs";
import { basename } from "node:path";

export interface SearchHit {
  sessionId: string;
  /** The project dir slug the transcript lives under (display hint). */
  projectSlug: string;
  snippet: string;
  mtimeMs: number;
}

/** Per-file match cap for stage-2 grep. Bounded (output ≤ cap × scanCap) but
 *  high enough that leading tool-payload matches rarely crowd out a real
 *  conversation-text hit (audit L2). */
export const STAGE2_MATCH_CAP = 80;

/** Extract the text content a human actually said/read from one JSONL line. */
export function textOfLine(parsed: unknown): string {
  const d = parsed as {
    type?: string;
    summary?: string;
    message?: { content?: unknown };
  };
  if (typeof d?.summary === "string") return d.summary;
  const content = d?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const blk = b as { type?: string; text?: string };
        return blk?.type === "text" && typeof blk.text === "string" ? blk.text : "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

/** ±window chars around the first case-insensitive match, ellipsized. */
export function snippetAround(text: string, term: string, window = 60): string | null {
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, idx - window);
  const end = Math.min(text.length, idx + term.length + window);
  const core = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${core}${end < text.length ? "…" : ""}`;
}

/** First conversation-text snippet among a file's matched JSONL lines. */
export function snippetFromLines(lines: string[], term: string): string | null {
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const snip = snippetAround(textOfLine(JSON.parse(line)), term);
      if (snip) return snip;
    } catch {
      /* partial line */
    }
  }
  return null;
}

/**
 * Run the search. Query is passed to grep with -F (fixed string — no regex
 * surface) and never touches a shell. Results are newest-first, capped.
 */
export async function searchTranscripts(
  term: string,
  opts: {
    projectsDir: string;
    limit?: number;
    scanCap?: number;
    grepFiles?: (term: string, dir: string) => Promise<string[]>;
    grepLines?: (term: string, files: string[]) => Promise<Map<string, string[]>>;
  },
): Promise<SearchHit[]> {
  const limit = opts.limit ?? 20;
  const scanCap = opts.scanCap ?? 120;
  const grepFiles =
    opts.grepFiles ??
    (async (t: string, dir: string): Promise<string[]> => {
      const p = Bun.spawn(
        ["grep", "-rilF", "--include=*.jsonl", "--", t, dir],
        { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
      );
      const out = await new Response(p.stdout).text();
      await p.exited; // grep exits 1 on no-match — the empty list already says so
      return out.split("\n").filter(Boolean);
    });
  // Stage 2 never reads whole transcripts (they run to tens of MB): ONE grep
  // pass prints up to STAGE2_MATCH_CAP matching lines per candidate file. The
  // cap is bounded (output ≤ cap × scanCap lines) but generous enough that a
  // real conversation-text hit isn't crowded out by leading tool-payload
  // matches (a term appearing in many tool_use paths/ids before a text block).
  // grep can't filter JSONL by block type, so this is mitigation, not a
  // guarantee — a file whose first STAGE2_MATCH_CAP matches are ALL payload
  // lines still misses a later text hit; unlikely at this cap.
  const grepLines =
    opts.grepLines ??
    (async (t: string, files: string[]): Promise<Map<string, string[]>> => {
      if (!files.length) return new Map();
      const p = Bun.spawn(["grep", "-HiF", "-m", String(STAGE2_MATCH_CAP), "--", t, ...files], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const out = await new Response(p.stdout).text();
      await p.exited;
      const byFile = new Map<string, string[]>();
      for (const row of out.split("\n")) {
        if (!row) continue;
        const sep = row.indexOf(":");
        if (sep < 0) continue;
        const file = row.slice(0, sep);
        const line = row.slice(sep + 1);
        const arr = byFile.get(file) ?? [];
        arr.push(line);
        byFile.set(file, arr);
      }
      return byFile;
    });

  const files = await grepFiles(term, opts.projectsDir);
  // Newest transcripts first; scan a bounded number of candidates.
  const dated = files
    .map((f) => {
      try {
        return { f, mtimeMs: statSync(f).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { f: string; mtimeMs: number } => x !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, scanCap);

  const lineMap = await grepLines(term, dated.map((d) => d.f));
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const { f, mtimeMs } of dated) {
    if (hits.length >= limit) break;
    const snip = snippetFromLines(lineMap.get(f) ?? [], term);
    if (!snip) continue; // term appears only in tool payloads/ids — not a conversation hit
    const parts = f.split("/");
    // A hit inside <uuid>/subagents/agent-*.jsonl belongs to the PARENT
    // session — that's the resumable unit the UI can open.
    const subIdx = parts.indexOf("subagents");
    const sessionId = subIdx > 0 ? parts[subIdx - 1] : basename(f, ".jsonl");
    const slugIdx = subIdx > 0 ? subIdx - 2 : parts.length - 2;
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    hits.push({
      sessionId,
      projectSlug: parts[slugIdx] ?? "",
      snippet: snip,
      mtimeMs,
    });
  }
  return hits;
}

// One full-corpus grep at a time — a typing user must never stack IO storms
// on the box. Queries serialize; each still runs (the client debounce keeps
// the queue shallow).
let searchTail: Promise<unknown> = Promise.resolve();

export function searchTranscriptsSerialized(
  term: string,
  opts: Parameters<typeof searchTranscripts>[1],
): Promise<SearchHit[]> {
  const run = searchTail.then(
    () => searchTranscripts(term, opts),
    () => searchTranscripts(term, opts),
  );
  searchTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
