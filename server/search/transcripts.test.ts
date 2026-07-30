import { describe, expect, test } from "bun:test";
import { tempDir } from "../testing/tmp";
import {
  searchTranscripts,
  snippetAround,
  snippetFromLines,
  textOfLine,
  STAGE2_MATCH_CAP,
} from "./transcripts";

describe("textOfLine — only conversation text counts", () => {
  test("assistant text blocks join; tool payloads are ignored", () => {
    expect(
      textOfLine({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "hello" },
            { type: "tool_use", input: { path: "/secret/needle.txt" } },
            { type: "text", text: "world" },
          ],
        },
      }),
    ).toBe("hello world");
  });

  test("user string content and summaries count", () => {
    expect(textOfLine({ type: "user", message: { content: "find the needle" } })).toBe(
      "find the needle",
    );
    expect(textOfLine({ type: "summary", summary: "needle summary" })).toBe("needle summary");
  });
});

describe("snippetAround", () => {
  test("case-insensitive window with ellipses", () => {
    const text = "x".repeat(100) + " the NEEDLE sits here " + "y".repeat(100);
    const s = snippetAround(text, "needle");
    expect(s).toContain("NEEDLE");
    expect(s!.startsWith("…")).toBe(true);
    expect(s!.endsWith("…")).toBe(true);
  });

  test("no match → null", () => {
    expect(snippetAround("nothing here", "needle")).toBeNull();
  });
});

describe("snippetFromLines — text hits only", () => {
  test("skips tool-payload matches and lands on the text hit", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", input: { path: "/tmp/needle" } }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "I found the needle in the code" }] },
      }),
    ];
    expect(snippetFromLines(lines, "needle")).toContain("found the needle");
  });

  test("payload-only matched lines yield null", () => {
    expect(
      snippetFromLines(
        [JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", input: { path: "/tmp/needle" } }] } })],
        "needle",
      ),
    ).toBeNull();
  });
});

describe("searchTranscripts — bounded, newest-first, payload-only dropped", () => {
  test("maps files to hits with sessionId + slug; payload-only files are dropped", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = tempDir("bifrost-search-");
    mkdirSync(join(root, "-slug-a"));
    mkdirSync(join(root, "-slug-b"));
    const fa = join(root, "-slug-a", "aaaa1111-0000-0000-0000-000000000000.jsonl");
    const fb = join(root, "-slug-b", "bbbb2222-0000-0000-0000-000000000000.jsonl");
    writeFileSync(fa, JSON.stringify({ type: "user", message: { content: "the needle is real" } }));
    writeFileSync(fb, JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", input: { path: "needle" } }] },
    }));
    const hits = await searchTranscripts("needle", {
      projectsDir: root,
      grepFiles: async () => [fa, fb],
    });
    expect(hits.length).toBe(1);
    expect(hits[0].sessionId).toBe("aaaa1111-0000-0000-0000-000000000000");
    expect(hits[0].projectSlug).toBe("-slug-a");
    expect(hits[0].snippet).toContain("needle is real");
  });
});

describe("stage-2 cap tolerates leading tool-payload matches (L2)", () => {
  test("a conversation-text line found AFTER many payload lines still yields a snippet", () => {
    const lines: string[] = [];
    // 40 leading tool-payload matches (term in a path/id, not conversation)
    for (let i = 0; i < 40; i++)
      lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", input: { path: "/x/needle" + i } }] } }));
    // then a real conversation-text hit
    lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "the needle in the haystack" }] } }));
    expect(snippetFromLines(lines, "needle")).toContain("needle in the haystack");
  });

  test("STAGE2_MATCH_CAP is bounded but well above a handful", () => {
    expect(STAGE2_MATCH_CAP).toBeGreaterThanOrEqual(50);
    expect(STAGE2_MATCH_CAP).toBeLessThanOrEqual(500);
  });
});
