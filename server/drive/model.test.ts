import { describe, expect, test } from "bun:test";
import { parseModelMenu, isModelConfirm, modelIndexByLabel } from "./model";

// Fixture captured LIVE from the /model picker (Claude Code v2.1.198,
// 2026-07-02) — the contract the parser encodes.
const PICKER = [
  "❯ Say only TURN-TWO.",
  "● TURN-TWO",
  "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
  "   Select model",
  "   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.",
  "     1. Default (recommended)  Opus 4.8 with 1M context · Best for everyday, complex tasks",
  "     2. Opus                   Opus 4.8 with 1M context · Best for everyday, complex tasks",
  "     3. Fable                  Fable 5 · Most capable for your hardest and longest-running tasks",
  "     4. Sonnet                 Sonnet 5 · Efficient for routine tasks",
  "   ❯ 5. Haiku ✔                Haiku 4.5 · Fastest for quick answers",
  "   ○ Effort not supported for Haiku",
  "   Enter to set as default · s to use this session only · Esc to cancel",
].join("\n");

describe("parseModelMenu — the /model picker contract", () => {
  test("parses the live chrome: five options, cursor + current on Haiku", () => {
    const m = parseModelMenu(PICKER);
    expect(m).not.toBeNull();
    expect(m!.options.map((o) => o.label)).toEqual([
      "Default (recommended)",
      "Opus",
      "Fable",
      "Sonnet",
      "Haiku",
    ]);
    expect(m!.cursorIndex).toBe(4);
    expect(m!.options[4].current).toBe(true);
    expect(m!.options.filter((o) => o.current)).toHaveLength(1);
    expect(m!.options[4].detail).toBe("Haiku 4.5 · Fastest for quick answers");
  });

  test("the un-numbered warning line is not an option row", () => {
    const m = parseModelMenu(PICKER)!;
    expect(m.options.some((o) => /Effort not supported/.test(o.label))).toBe(false);
  });

  test("a clipped picker (footer scrolled off — small window) returns null, never a guess", () => {
    const clipped = PICKER.split("\n").slice(0, -1).join("\n");
    expect(parseModelMenu(clipped)).toBeNull();
  });

  test("a pane without the picker returns null", () => {
    expect(parseModelMenu("❯ Say only TURN-TWO.\n● TURN-TWO\n  ← for agents")).toBeNull();
  });

  test("cursor on a non-current row: cursor and ✔ are independent", () => {
    const moved = PICKER.replace("   ❯ 5. Haiku ✔", "     5. Haiku ✔").replace(
      "     4. Sonnet",
      "   ❯ 4. Sonnet",
    );
    const m = parseModelMenu(moved)!;
    expect(m.cursorIndex).toBe(3);
    expect(m.options[4].current).toBe(true);
  });
});

describe("isModelConfirm — the post-'s' cache-cost confirm", () => {
  test("detects the confirm stage", () => {
    const confirm = [
      "   Switch model?",
      "   Your next response will be slower and use more tokens",
      "   ❯ 1. Yes, switch to Sonnet 5",
      "     2. No, go back",
    ].join("\n");
    expect(isModelConfirm(confirm)).toBe(true);
  });

  test("an ordinary pane is not a confirm", () => {
    expect(isModelConfirm(PICKER)).toBe(false);
  });
});

describe("modelIndexByLabel — resolve a peeked choice against a fresh parse", () => {
  const opts = [
    { label: "Default (recommended)", detail: "", current: false },
    { label: "Opus", detail: "", current: false },
    { label: "Haiku", detail: "", current: true },
  ];
  test("finds the row by label regardless of position", () => {
    expect(modelIndexByLabel(opts, "Haiku")).toBe(2);
    expect(modelIndexByLabel(opts, "Default (recommended)")).toBe(0);
  });
  test("a label no longer offered returns -1", () => {
    expect(modelIndexByLabel(opts, "Sonnet")).toBe(-1);
  });
});
