import { describe, expect, test } from "bun:test";
import { parseCommandTurn, stripAnsi } from "./commandView";

// Shapes from real transcripts (2026-06/07 corpus).
const COMMAND = `<command-name>/model</command-name>
            <command-message>model</command-message>
            <command-args>claude-opus-4-8[1m]</command-args>`;

describe("parseCommandTurn — slash-command turns render as chips, not raw XML", () => {
  test("a command turn yields name + args", () => {
    expect(parseCommandTurn(COMMAND)).toEqual({
      kind: "command",
      name: "/model",
      args: "claude-opus-4-8[1m]",
    });
  });

  test("a command without args yields empty args", () => {
    expect(parseCommandTurn("<command-name>/clear</command-name>")).toEqual({
      kind: "command",
      name: "/clear",
      args: "",
    });
  });

  test("local command stdout is extracted with ANSI styling stripped", () => {
    const t = parseCommandTurn(
      "<local-command-stdout>Set model to [1mSonnet 5[22m for this session only</local-command-stdout>",
    );
    expect(t).toEqual({ kind: "output", text: "Set model to Sonnet 5 for this session only" });
  });

  test("stderr variant is handled the same way", () => {
    expect(parseCommandTurn("<local-command-stderr>boom</local-command-stderr>")).toEqual({
      kind: "output",
      text: "boom",
    });
  });

  test("ordinary prose is untouched — even prose that mentions the tags mid-text", () => {
    expect(parseCommandTurn("hello world")).toBeNull();
    expect(parseCommandTurn("what does <command-name> mean in a transcript?")).toBeNull();
  });
});

describe("stripAnsi — SGR only, anchored on ESC", () => {
  test("strips styling sequences", () => {
    expect(stripAnsi("[1mbold[22m and [38;5;214mcolour[0m")).toBe(
      "bold and colour",
    );
  });

  test("literal bracket-digit-m text survives (model names carry it)", () => {
    expect(stripAnsi("claude-opus-4-8[1m]")).toBe("claude-opus-4-8[1m]");
  });
});
