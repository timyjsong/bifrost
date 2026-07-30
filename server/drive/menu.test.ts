import { describe, expect, test } from "bun:test";
import {
  modeFromPane,
  parsePermissionMenu,
  isValidAnswerKey,
  isPaneWorking,
  parsePermissionMode,
  detectSignalDrift,
  WORKING_DRIFT_IDLE_MS,
} from "./menu";

// Fixture mirrors the live Claude Code permission dialog (boxed, ❯ cursor).
// If the format drifts in a future Claude Code, this fixture and the parser
// update together, and the loud fallback covers the gap.
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

  test("an elapsed timer alone IS the signal (contract inverted 2026-07-02)", () => {
    // The 06-17 contract keyed on "esc to interrupt" and rejected the timer as
    // flickery. The current CC TUI DROPPED the literal (verified live across
    // full turns), so the timer evidence is the primary signal now — capture
    // flicker is absorbed by the pane route's server-side hold (workingHold).
    expect(isPaneWorking("● thinking… (5s · ↑ 1.2k tokens)\n❯")).toBe(true);
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

describe("parsePermissionMode — read the mode off the pane (spike-verified strings)", () => {
  const bar = (s: string) => `❯ try something\n──────────\n  ${s} · ← for agents   /rc active`;
  test("auto / accept edits / plan are each detected", () => {
    expect(parsePermissionMode(bar("⏵⏵ auto mode on (shift+tab to cycle)"))).toBe("auto");
    expect(parsePermissionMode(bar("⏵⏵ accept edits on (shift+tab to cycle)"))).toBe("accept-edits");
    expect(parsePermissionMode(bar("⏸ plan mode on (shift+tab to cycle)"))).toBe("plan");
  });
  test("plan is matched before auto (its 'mode on' can't be mistaken)", () => {
    expect(parsePermissionMode("⏸ plan mode on")).toBe("plan");
  });
  test("no mode line → null", () => {
    expect(parsePermissionMode("just some transcript text")).toBeNull();
  });
});


describe("detectSignalDrift — mode drift guard (working branch retired)", () => {
  test("the mode-cycle hint with an unrecognizable mode flags mode drift", () => {
    expect(detectSignalDrift("x\n⏵⏵ turbo mode on (shift+tab to cycle)")).toEqual(["mode"]);
  });

  test("a recognizable mode with the hint is not drift", () => {
    expect(detectSignalDrift("x\n⏵⏵ accept edits on (shift+tab to cycle)")).toEqual([]);
  });

  test("an idle pane / turn evidence alone is never drift", () => {
    expect(detectSignalDrift("transcript…\n> \n? for shortcuts")).toEqual([]);
    expect(detectSignalDrift("x\n✶ Gallivanting… (2s · thinking)\n❯ ")).toEqual([]);
  });
});

describe("isPaneWorking — re-derived signal, live-observed shapes (2026-07-02)", () => {
  test("the thinking phase '(2s · thinking)' reads working (literal gone from current TUI)", () => {
    expect(isPaneWorking("x\n✶ Gallivanting… (2s · thinking)\n❯ ")).toBe(true);
  });

  test("the token phase and stop-hooks phase read working", () => {
    expect(isPaneWorking("x\n✻ Churning (16s · ↓ 1.5k tokens)\n❯ ")).toBe(true);
    expect(isPaneWorking("x\n(Stop hooks… 1/3 · 16s · ↓ 1.5k tokens)\n❯ ")).toBe(true);
  });

  test("the old literal still reads working (older TUIs / attached panes)", () => {
    expect(isPaneWorking("x\n✻ Churning (esc to interrupt)\n❯ ")).toBe(true);
  });

  test("an idle pane reads idle; scrollback timers beyond the window are ignored", () => {
    expect(isPaneWorking("transcript…\n> \n? for shortcuts")).toBe(false);
    const scrollback =
      "old output (23s · ↓ 4.1k tokens)\n" + Array(12).fill("line").join("\n") + "\n> ";
    expect(isPaneWorking(scrollback)).toBe(false);
  });
});

describe("parsePermissionMenu — cursored colon-prompt menus (rewind confirm)", () => {
  // Faithful to the live capture: FOUR context lines between prompt and options.
  const REWIND_CONFIRM = [
    "  Rewind",
    "  Confirm you want to restore to the point before you sent this message:",
    "  │ Say only TURN-TWO.",
    "  │ (36s ago)",
    "  The conversation will be forked.",
    "  The code will be unchanged.",
    "  ❯ 1. Restore conversation",
    "    2. Summarize from here",
    "    3. Summarize up to here",
    "    4. Never mind",
  ].join("\n");

  test("the live-captured rewind confirm parses (colon prompt + cursored row)", () => {
    const m = parsePermissionMenu(REWIND_CONFIRM);
    expect(m).not.toBeNull();
    expect(m!.options.length).toBe(4);
    expect(m!.options[0].label).toContain("Restore conversation");
  });

  test("a colon-preceded numbered LIST without a cursor still rejects (M5 guard)", () => {
    const list = [
      "here are the options:",
      "1. first thing",
      "2. second thing",
    ].join("\n");
    expect(parsePermissionMenu(list)).toBeNull();
  });
});

describe("detectSignalDrift — working-drift backstop (M2, mtime cross-check)", () => {
  const workingPane = "x\n✻ Churning (16s · ↓ 1.5k tokens)\n❯ ";

  test("timer present + transcript idle past the threshold → working drift", () => {
    expect(detectSignalDrift(workingPane, WORKING_DRIFT_IDLE_MS + 1)).toEqual(["working"]);
  });

  test("timer present + transcript RECENTLY written → no drift (a live turn / long tool call)", () => {
    expect(detectSignalDrift(workingPane, 5_000)).toEqual([]);
    expect(detectSignalDrift(workingPane, WORKING_DRIFT_IDLE_MS - 1)).toEqual([]);
  });

  test("no transcriptIdleMs supplied → backstop inert (only mode drift possible)", () => {
    expect(detectSignalDrift(workingPane)).toEqual([]);
  });

  test("idle transcript but NO timer → no working drift (genuinely idle session)", () => {
    expect(detectSignalDrift("x\n❯ \n? for shortcuts", WORKING_DRIFT_IDLE_MS + 10_000)).toEqual([]);
  });
});

describe("modeFromPane — the pane route's mode reading", () => {
  test("a readable pane with NO mode string is the default mode (the current TUI renders nothing for it)", () => {
    expect(modeFromPane("some transcript\n❯ \n  ← for agents")).toBe("auto");
  });

  test("explicit mode strings pass through", () => {
    expect(modeFromPane("x\n⏸ plan mode on")).toBe("plan");
    expect(modeFromPane("x\n⏵⏵ accept edits on")).toBe("accept-edits");
  });

  test("an EMPTY capture stays null — unknown, never a guessed mode", () => {
    expect(modeFromPane("")).toBeNull();
    expect(modeFromPane("   \n  ")).toBeNull();
  });
});
