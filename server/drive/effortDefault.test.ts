import { describe, expect, test } from "bun:test";
import { replaceEffortLevel, shouldRestoreEffortDefault } from "./effortDefault";

describe("shouldRestoreEffortDefault — undo only OUR side-write", () => {
  test("the slider's confirm moved the default to our selection → restore", () => {
    expect(shouldRestoreEffortDefault("xhigh", "low", "low")).toBe(true);
  });

  test("the default didn't move (the TUI's first-use session-only path) → nothing to undo", () => {
    expect(shouldRestoreEffortDefault("xhigh", "xhigh", "max")).toBe(false);
  });

  test("selecting the value the default already had → no-op either way", () => {
    expect(shouldRestoreEffortDefault("xhigh", "xhigh", "xhigh")).toBe(false);
  });

  test("the file moved to something we did NOT select (concurrent user edit) → leave it alone", () => {
    expect(shouldRestoreEffortDefault("xhigh", "medium", "low")).toBe(false);
  });

  test("no prior key on record → nothing to restore to", () => {
    expect(shouldRestoreEffortDefault(undefined, "low", "low")).toBe(false);
  });
});

describe("replaceEffortLevel — surgical, format-preserving", () => {
  const FILE = `{
  "env": {
    "CLAUDE_CODE_WORKFLOWS": "1"
  },
  "effortLevel": "low",
  "model": "opus[1m]"
}`;

  test("swaps only the effortLevel value; every other byte survives", () => {
    const out = replaceEffortLevel(FILE, "xhigh");
    expect(out).toContain('"effortLevel": "xhigh"');
    expect(out.replace('"effortLevel": "xhigh"', '"effortLevel": "low"')).toBe(FILE);
  });

  test("a file without the key is returned untouched", () => {
    const noKey = `{"model": "opus[1m]"}`;
    expect(replaceEffortLevel(noKey, "xhigh")).toBe(noKey);
  });

  test("a non-label value is refused (never inject into user config)", () => {
    expect(replaceEffortLevel(FILE, 'x", "evil": "1')).toBe(FILE);
  });
});
