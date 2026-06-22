import { describe, expect, test } from "bun:test";
import { summarizeTool, buildToolIndex, visibleBlocks } from "./toolView";
import type { ContentBlock, InteractionMessage } from "../../../shared/types";

const msg = (over: Partial<InteractionMessage>): InteractionMessage => ({
  uuid: Math.random().toString(36).slice(2),
  role: "assistant",
  blocks: [],
  ...over,
});

describe("summarizeTool — config-driven one-liner", () => {
  test("Bash → command, Read/Edit/Write → file path, Grep → pattern", () => {
    expect(summarizeTool("Bash", { command: "npm test" })).toBe("npm test");
    expect(summarizeTool("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(summarizeTool("Grep", { pattern: "TODO" })).toBe("TODO");
  });

  test("unknown tool falls back to a generic field, then compact JSON", () => {
    expect(summarizeTool("MysteryTool", { url: "http://x" })).toBe("http://x");
    expect(summarizeTool("MysteryTool", { foo: 1 })).toBe('{"foo":1}');
  });

  test("is not clipped (the row clips for display; expanded shows full)", () => {
    const long = "x".repeat(500);
    expect(summarizeTool("Bash", { command: long })).toBe(long);
  });

  test("a string input passes through; an empty object is empty", () => {
    expect(summarizeTool("Whatever", "raw")).toBe("raw");
    expect(summarizeTool("Whatever", {})).toBe("");
  });
});

describe("buildToolIndex — pair tool_use with its later tool_result", () => {
  const messages: InteractionMessage[] = [
    msg({
      role: "assistant",
      blocks: [
        { kind: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ],
    }),
    msg({
      role: "user",
      blocks: [{ kind: "tool_result", forId: "t1", text: "a\nb", isError: false }],
    }),
    msg({
      role: "user",
      blocks: [
        { kind: "tool_result", forId: "orphan", text: "stray", isError: true },
      ],
    }),
  ];

  test("a tool_use is matched to its result; the forId is marked consumed", () => {
    const idx = buildToolIndex(messages);
    expect(idx.resultByUseId.get("t1")).toEqual({ text: "a\nb", isError: false });
    expect(idx.consumedForIds.has("t1")).toBe(true);
  });

  test("an orphan tool_result (no matching tool_use) is NOT consumed", () => {
    const idx = buildToolIndex(messages);
    expect(idx.consumedForIds.has("orphan")).toBe(false);
    expect(idx.resultByUseId.has("orphan")).toBe(false);
  });
});

describe("visibleBlocks — drop results folded into their tool-call unit", () => {
  const blocks: ContentBlock[] = [
    { kind: "text", text: "hi" },
    { kind: "tool_result", forId: "t1", text: "out", isError: false }, // consumed
    { kind: "tool_result", forId: "z9", text: "orphan", isError: false }, // kept
  ];

  test("a consumed tool_result is hidden; text and orphan results stay", () => {
    const out = visibleBlocks(blocks, new Set(["t1"]));
    expect(out).toHaveLength(2);
    expect(out.some((b) => b.kind === "tool_result" && b.forId === "t1")).toBe(false);
    expect(out.some((b) => b.kind === "tool_result" && b.forId === "z9")).toBe(true);
  });
});
