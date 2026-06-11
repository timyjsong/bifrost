import { describe, expect, test } from "bun:test";
import { parseHead, parseTail, isHeadless } from "./collectors/sessions";

const line = (obj: unknown) => JSON.stringify(obj);

const userLine = (text: string, extra: Record<string, unknown> = {}) =>
  line({
    type: "user",
    cwd: "/home/you/proj",
    gitBranch: "main",
    entrypoint: "cli",
    timestamp: "2026-06-11T10:00:00.000Z",
    message: { role: "user", content: text },
    ...extra,
  });

const assistantLine = (
  content: unknown[],
  stop: string | null,
  extra: Record<string, unknown> = {},
) =>
  line({
    type: "assistant",
    timestamp: "2026-06-11T10:01:00.000Z",
    message: {
      role: "assistant",
      content,
      stop_reason: stop,
      model: "claude-sonnet-4-6",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 90,
      },
    },
    ...extra,
  });

describe("parseHead", () => {
  test("first real prompt becomes the title; wrappers skipped", () => {
    const head = parseHead(
      [
        userLine("Caveat: harness wrapper text"),
        userLine("<command-name>/clear</command-name>"),
        userLine("build me a dashboard"),
      ].join("\n"),
      "sid-1",
    )!;
    expect(head.title).toBe("build me a dashboard");
    expect(head.cwd).toBe("/home/you/proj");
    expect(head.entrypoint).toBe("cli");
  });
  test("custom-title captured from the head window", () => {
    const head = parseHead(
      [
        line({ type: "custom-title", customTitle: "LEDGER" }),
        userLine("get to work"),
      ].join("\n"),
      "sid-t",
    )!;
    expect(head.customTitle).toBe("LEDGER");
  });
  test("sidechain flag detected", () => {
    const head = parseHead(
      userLine("sub work", { isSidechain: true }),
      "sid-2",
    )!;
    expect(head.sidechain).toBe(true);
  });
  test("garbage chunk yields null", () => {
    expect(parseHead("not json\n{broken", "sid-3")).toBeNull();
  });
});

describe("parseTail", () => {
  test("completed turn = assistant_done, usage summed, model captured", () => {
    const tail = parseTail(
      [
        userLine("do the thing"),
        assistantLine([{ type: "text", text: "All done." }], "end_turn"),
      ].join("\n"),
    );
    expect(tail.lastEntry).toBe("assistant_done");
    expect(tail.openTools).toBe(0);
    expect(tail.contextTokens).toBe(1100);
    expect(tail.model).toBe("claude-sonnet-4-6");
    expect(tail.nowDoing).toBe("All done.");
  });
  test("dangling tool call = assistant_tool with open tool", () => {
    const tail = parseTail(
      assistantLine(
        [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
        "tool_use",
      ),
    );
    expect(tail.lastEntry).toBe("assistant_tool");
    expect(tail.openTools).toBe(1);
  });
  test("tool_result resolves the open tool", () => {
    const tail = parseTail(
      [
        assistantLine(
          [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
          "tool_use",
        ),
        line({
          type: "user",
          timestamp: "2026-06-11T10:02:00.000Z",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
          },
        }),
      ].join("\n"),
    );
    expect(tail.openTools).toBe(0);
    expect(tail.lastEntry).toBe("tool_result");
  });
  test("described calls are collected, resolved or not — processes outlive calls", () => {
    const tail = parseTail(
      [
        assistantLine(
          [
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "bun run check", description: "Run the gate" },
            },
            {
              type: "tool_use",
              id: "t2",
              name: "Bash",
              input: { command: "sleep 99", description: "Long nap" },
            },
          ],
          "tool_use",
        ),
        line({
          type: "user",
          timestamp: "2026-06-11T10:02:00.000Z",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
          },
        }),
      ].join("\n"),
    );
    expect(tail.calls).toEqual([
      { command: "bun run check", description: "Run the gate" },
      { command: "sleep 99", description: "Long nap" },
    ]);
    expect(tail.openTools).toBe(1);
  });
  test("custom-title entries: last in window wins", () => {
    const tail = parseTail(
      [
        line({ type: "custom-title", customTitle: "Old Name" }),
        userLine("hello"),
        line({ type: "custom-title", customTitle: "Atlas Work" }),
      ].join("\n"),
    );
    expect(tail.customTitle).toBe("Atlas Work");
  });
  test("typed prompt last = user_prompt with lastPromptAt", () => {
    const tail = parseTail(
      [
        assistantLine([{ type: "text", text: "earlier" }], "end_turn"),
        userLine("next request"),
      ].join("\n"),
    );
    expect(tail.lastEntry).toBe("user_prompt");
    expect(tail.lastPromptAt).toBe(Date.parse("2026-06-11T10:00:00.000Z"));
  });
});

describe("isHeadless", () => {
  test("sdk entrypoints are headless; cli/desktop are not; unknown stays undefined", () => {
    expect(isHeadless("sdk-cli")).toBe(true);
    expect(isHeadless("cli")).toBe(false);
    expect(isHeadless("claude-desktop")).toBe(false);
    expect(isHeadless(undefined)).toBeUndefined();
  });
});
