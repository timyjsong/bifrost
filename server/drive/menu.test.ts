import { describe, expect, test } from "bun:test";
import { parsePermissionMenu, isValidAnswerKey, isPaneWorking } from "./menu";

// Fixture mirrors the assumed Claude Code permission dialog (boxed, ❯ cursor).
// NOTE: confirm against a live prompt at review — if the real format differs,
// this fixture and the parser update together, and the loud fallback covers the gap.
const BOXED = `
╭───────────────────────────────────────────────╮
│ Bash command                                  │
│                                               │
│   rm -rf build                                │
│   Remove the build dir                        │
│                                               │
│ Do you want to proceed?                       │
│ ❯ 1. Yes                                      │
│   2. Yes, and don't ask again this session    │
│   3. No, and tell Claude what to do (esc)     │
╰───────────────────────────────────────────────╯
`;

describe("parsePermissionMenu", () => {
  test("extracts the question and the numbered options from a boxed dialog", () => {
    const menu = parsePermissionMenu(BOXED);
    expect(menu).not.toBeNull();
    expect(menu!.prompt).toBe("Do you want to proceed?");
    expect(menu!.options.map((o) => o.key)).toEqual(["1", "2", "3"]);
    expect(menu!.options[0].label).toBe("Yes");
    expect(menu!.options[2].label).toContain("No");
  });

  test("works without box-drawing chrome (plain text)", () => {
    const plain = "Do you want to proceed?\n1. Yes\n2. No";
    const menu = parsePermissionMenu(plain)!;
    expect(menu.options).toHaveLength(2);
    expect(menu.prompt).toBe("Do you want to proceed?");
  });

  test("returns null when there is no menu (ordinary output)", () => {
    expect(parsePermissionMenu("just some text\nrunning tests\nall good")).toBeNull();
    expect(parsePermissionMenu("")).toBeNull();
  });

  test("a single stray numbered line is not a menu", () => {
    expect(parsePermissionMenu("step 1. do the thing\nnothing else")).toBeNull();
  });

  test("incidental numbered list (not starting a sequential run at 1+2) is ignored", () => {
    // a lone '3.' with no 1./2. preceding is not a menu
    expect(parsePermissionMenu("see note 3. for details")).toBeNull();
  });

  test("prefers the later menu when the pane holds a stale one above", () => {
    const two = "Old?\n1. A\n2. B\n...scroll...\nNew question?\n1. Yes\n2. No";
    const menu = parsePermissionMenu(two)!;
    expect(menu.prompt).toBe("New question?");
    expect(menu.options.map((o) => o.label)).toEqual(["Yes", "No"]);
  });

  // The M5 review fix: an ordinary numbered list in conversation must NOT read as
  // a permission prompt.
  test("a numbered list mid-pane (output below it) is NOT a menu", () => {
    const filler = Array.from({ length: 12 }, (_, i) => `output line ${i}`).join("\n");
    const pane = `Here are the steps:\n1. first\n2. second\n3. third\n${filler}`;
    expect(parsePermissionMenu(pane)).toBeNull();
  });

  test("a bottom-anchored numbered list with no question above is NOT a menu", () => {
    expect(parsePermissionMenu("here are two options\n1. apples\n2. oranges")).toBeNull();
  });

  test("a question above a list still needs the list at the bottom", () => {
    const filler = Array.from({ length: 12 }, () => "more output").join("\n");
    expect(parsePermissionMenu(`What next?\n1. a\n2. b\n${filler}`)).toBeNull();
  });
});

// Fixtures from real claude panes (the status bars were captured live). "working"
// = the main turn is in flight: the bar reads "esc to interrupt". The moment
// control returns the bar flips to "← for agents" — even with bg work still going.
const WORKING_PANE = `  Running 1 shell command…
  ⎿  $ cd /home/you/bifrost
✢ Crystallizing… (2m 55s · ↓ 11.5k tokens)
  ⎿  Tip: Use /btw to ask a quick side question
────────────────────────────────────────────────
❯ some queued text
────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt        /rc active`;

const IDLE_PANE = `● Done — here's the result.
  ⎿  output line one
     output line two
────────────────────────────────────────────────
❯
────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents        /rc active`;

// Soft idle: control is back with the user, but a background shell is still
// running. NOT mid-processing → send must be enabled, so this reads false.
const SOFT_IDLE_BG_PANE = `❯ run sleep 120 in the background
● BG-STARTED
✻ Crunched for 10s · 1 shell still running
────────────────────────────────────────────────
❯
────────────────────────────────────────────────
  ⏵⏵ auto mode on · 1 shell · ← for agents · ↓ to manage        /rc active`;

describe("isPaneWorking", () => {
  test("the main turn is in flight ('esc to interrupt' in the status bar)", () => {
    expect(isPaneWorking(WORKING_PANE)).toBe(true);
    expect(
      isPaneWorking("✶ Thinking…\n❯\n  ⏵⏵ auto mode on · esc to interrupt"),
    ).toBe(true);
  });

  test("control returned (no 'esc to interrupt') means not working", () => {
    expect(isPaneWorking(IDLE_PANE)).toBe(false);
    expect(isPaneWorking("")).toBe(false);
    expect(isPaneWorking("just some output\n❯ ")).toBe(false);
  });

  test("soft idle with a background shell still running is NOT working", () => {
    expect(isPaneWorking(SOFT_IDLE_BG_PANE)).toBe(false);
  });

  test("an elapsed timer alone (no 'esc to interrupt') is not the signal", () => {
    // the old heuristic flickered on this; the bar marker is what counts now
    expect(isPaneWorking("● thinking… (5s · ↑ 1.2k tokens)\n❯")).toBe(false);
  });

  test("a stray 'esc to interrupt' deep in scrollback doesn't count", () => {
    const filler = Array.from({ length: 15 }, () => "more output").join("\n");
    expect(isPaneWorking(`hint: press esc to interrupt\n${filler}\n❯`)).toBe(false);
  });
});

describe("isValidAnswerKey", () => {
  test("accepts single digits and Enter; rejects everything else", () => {
    for (const k of ["1", "2", "9", "Enter"]) expect(isValidAnswerKey(k)).toBe(true);
    for (const k of ["0", "10", "C-c", "Escape", "rm", "", "1; rm"])
      expect(isValidAnswerKey(k)).toBe(false);
  });
});
