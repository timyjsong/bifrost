import { describe, expect, test } from "bun:test";
import { parseRewindMenu, rewindIndexByIdentity } from "./rewind";

// The chrome as captured live (2026-07-02) — the contract fixture.
const LIVE_MENU = [
  "✻ Sautéed for 2s",
  "────────────────────────────────────────",
  "  Rewind",
  "  Restore the code and/or conversation to the point before…",
  "    Say only TURN-ONE.",
  "    No code changes",
  "  ❯ Say only TURN-TWO.",
  "    No code changes",
  "    (current)",
  "  Enter to continue · Esc to cancel",
].join("\n");

describe("parseRewindMenu — the live-captured chrome", () => {
  test("parses checkpoints, details, and the cursor position", () => {
    const m = parseRewindMenu(LIVE_MENU);
    expect(m).not.toBeNull();
    expect(m!.checkpoints).toEqual([
      { label: "Say only TURN-ONE.", detail: "No code changes" },
      { label: "Say only TURN-TWO.", detail: "No code changes" },
    ]);
    expect(m!.cursorIndex).toBe(1); // cursor on TURN-TWO's row
  });

  test("cursor on (current) reads as checkpoints.length", () => {
    const onCurrent = LIVE_MENU.replace("  ❯ Say only TURN-TWO.", "    Say only TURN-TWO.")
      .replace("    (current)", "  ❯ (current)");
    const m = parseRewindMenu(onCurrent);
    expect(m!.cursorIndex).toBe(2);
  });

  test("a pane without the rewind chrome returns null (loud fallback)", () => {
    expect(parseRewindMenu("just a conversation\n❯ \n← for agents")).toBeNull();
    expect(parseRewindMenu("")).toBeNull();
  });
});

describe("rewindIndexByIdentity — resolve a peeked checkpoint safely", () => {
  const cps = [
    { label: "First prompt.", detail: "No code changes" },
    { label: "Second prompt.", detail: "3 files" },
    { label: "Third prompt.", detail: "No code changes" },
  ];
  test("matches a unique (label, detail) even after the list grew", () => {
    // A newer turn prepended nothing but appended — index shifts, identity holds.
    const grown = [...cps, { label: "Fourth prompt.", detail: "1 file" }];
    expect(rewindIndexByIdentity(grown, { label: "Third prompt.", detail: "No code changes" })).toBe(2);
  });
  test("a checkpoint no longer present returns -1", () => {
    expect(rewindIndexByIdentity(cps, { label: "Gone prompt.", detail: "x" })).toBe(-1);
  });
  test("REFUSES to guess on an ambiguous match — destructive op", () => {
    const dup = [
      { label: "Same.", detail: "No code changes" },
      { label: "Same.", detail: "No code changes" },
    ];
    expect(rewindIndexByIdentity(dup, { label: "Same.", detail: "No code changes" })).toBe(-1);
  });
});
