import { describe, expect, test } from "bun:test";
import { pickerVisible } from "./picker";

describe("pickerVisible — the Esc guard's footer detection", () => {
  test("each full-screen picker's footer is recognized", () => {
    expect(pickerVisible("  Rewind\n  ❯ (current)\n  Enter to continue · Esc to cancel")).toBe(true);
    expect(pickerVisible("   Select model\n   Enter to set as default · s to use this session only · Esc to cancel")).toBe(true);
    expect(pickerVisible("   Effort\n   ←/→ to adjust · Enter to confirm · Esc to cancel")).toBe(true);
  });

  test("an idle pane, a working turn, and a permission menu are NOT pickers", () => {
    expect(pickerVisible("❯ \n  ← for agents")).toBe(false);
    expect(pickerVisible("✻ Churning (16s · ↓ 1.5k tokens)\n❯ ")).toBe(false);
    expect(
      pickerVisible("Allow this tool?\n❯ 1. Yes\n  2. No, tell Claude what to do differently"),
    ).toBe(false);
  });

  test("an empty capture is not a picker (no keys sent for a vanished pane)", () => {
    expect(pickerVisible("")).toBe(false);
  });
});
