/**
 * Channel 3 — the permission-menu parser. Pure (pane text in → menu out), so the
 * brittle bit (TUI chrome shifts across Claude Code versions) is isolated and
 * tested. This is best-effort by design: when it returns null the UI does NOT
 * guess — it shows the raw pane and routes you to the prompt box / raw terminal
 * (the loud fallback, AC5.3). A wrong auto-answer is the one outcome we refuse.
 *
 * Format (confirmed against live permission prompts): the
 * permission dialog renders a question line ending in "?", then numbered choices
 * "1. Yes …", "2. …", "3. No …", optionally inside a box-drawing frame with a
 * "❯" cursor on the selected row. We key on a run of sequentially-numbered
 * options starting at 1 — strong enough to ignore incidental numbered text.
 */
import type { PermissionMenu, PermissionMode } from "../../shared/types";
export type { PermissionMenu };

// Strip box-drawing borders / cursor glyphs / padding so the option text is bare.
function strip(s: string): string {
  return s.replace(/[│|╭╮╰╯─━┃┏┓┗┛▌▐]/g, " ").replace(/[❯>›▶]/g, " ").trim();
}

const OPTION = /^(\d+)\.\s+(.*\S)\s*$/;
const BOTTOM_WINDOW = 8; // an active menu lives at the bottom of the pane

export function parsePermissionMenu(paneText: string): PermissionMenu | null {
  // Non-empty, chrome-stripped lines (positions among non-empty lines preserved).
  // Track which lines carried the ❯ cursor BEFORE stripping: a cursored
  // numbered row is strong evidence of a real interactive menu (conversation
  // text never renders cursors), which relaxes the prompt-line gate below.
  const ne: string[] = [];
  const cursored: boolean[] = [];
  for (const raw of paneText.split("\n")) {
    const s = strip(raw);
    if (s) {
      ne.push(s);
      cursored.push(/❯\s*\d+\./.test(raw));
    }
  }
  if (ne.length < 2) return null;

  // The active menu, if any, is the LAST sequential 1.,2.,… run in the pane.
  let runStart = -1;
  let options: { key: string; label: string }[] = [];
  for (let i = 0; i < ne.length; i++) {
    const m = ne[i].match(OPTION);
    if (!m || Number(m[1]) !== 1) continue; // a run must open with "1."
    const opts = [{ key: "1", label: m[2].trim() }];
    let expect = 2;
    let k = i + 1;
    while (k < ne.length) {
      const mk = ne[k].match(OPTION);
      if (mk && Number(mk[1]) === expect) {
        opts.push({ key: mk[1], label: mk[2].trim() });
        expect++;
        k++;
      } else break;
    }
    if (opts.length >= 2) {
      runStart = i;
      options = opts; // keep the bottom-most valid run
    }
  }
  if (runStart < 0) return null;

  // Two gates that distinguish a REAL permission prompt from an ordinary numbered
  // list in conversation output (the M5 review fix — a list was false-firing):
  // 1. Bottom-anchored — the active prompt sits at the foot of the pane; a list in
  //    output has the input box / more text below it.
  const lastOptIdx = runStart + options.length - 1;
  if (lastOptIdx < ne.length - BOTTOM_WINDOW) return null;
  // 2. A question line ("…?") within the 3 lines just above the options — OR,
  //    when an option row carries the ❯ cursor (a selectable TUI menu, e.g.
  //    the rewind confirm), a prompt line ending in ":" qualifies too. The
  //    "?" -only gate was the M5 false-fire fix; the cursor is the equally
  //    strong signal that this is chrome, not conversation.
  const hasCursoredOption = cursored
    .slice(runStart, runStart + options.length)
    .some(Boolean);
  // The rewind confirm interposes four context lines (quoted message, age,
  // fork/code notes) between its colon-prompt and the options — 6 covers it.
  let prompt = "";
  for (let j = runStart - 1; j >= 0 && j >= runStart - 6; j--) {
    if (ne[j].endsWith("?") || (hasCursoredOption && ne[j].endsWith(":"))) {
      prompt = ne[j];
      break;
    }
  }
  if (!prompt) return null;

  return { prompt, options };
}

/** A menu answer is a single digit (a numbered choice) or Enter (accept default).
 *  Anything else is rejected — the answer surface stays deliberately tiny. */
export function isValidAnswerKey(key: string): boolean {
  return /^[1-9]$/.test(key) || key === "Enter";
}

// The working signal, re-derived 2026-07-02: the current Claude Code TUI no
// longer renders "esc to interrupt" (verified across full turns at 220 cols),
// so the primary evidence is the spinner's elapsed-timer segment — a
// parenthesized "(Ns · …)" group ("(2s · thinking)", "(16s · ↓ 1.5k tokens)",
// "(Stop hooks… 1/3 · 16s · …)") that only renders while a turn is in flight.
// At 500ms sampling it read CONTINUOUS through a live turn; the pane route
// additionally smooths transitional redraws with a short server-side hold
// (workingHold.ts). The old literal stays as an OR for TUI versions/panes
// that still show it. The spinner line sits above the input box (~7 chrome
// lines), so the scan window is the last 10 non-empty lines.
const WORKING_LITERAL = /esc to interrupt/;
const TURN_TIMER = /\([^)\n]*\b\d+m?\s?\d*s\s*·[^)\n]*\)/;

export function isPaneWorking(paneText: string): boolean {
  const foot = paneText
    .split("\n")
    .filter((l) => l.trim())
    .slice(-10)
    .join("\n");
  return WORKING_LITERAL.test(foot) || TURN_TIMER.test(foot);
}

/** Read the current permission mode off a captured pane, or null if the status
 *  line isn't visible. The TUI shows `⏵⏵ auto mode on`, `⏵⏵ accept edits on`, or
 *  `⏸ plan mode on` (cycle + strings verified by spike). Plan is checked first so
 *  its "mode on" can't be mistaken for auto. */
export function parsePermissionMode(paneText: string): PermissionMode | null {
  const t = paneText.toLowerCase();
  if (/plan mode on/.test(t)) return "plan";
  if (/accept edits on/.test(t)) return "accept-edits";
  if (/auto mode on/.test(t)) return "auto";
  return null;
}

/** The pane route's mode reading. The current TUI renders NOTHING on the status
 *  bar for the default mode (verified live 2026-07-02), so a readable capture
 *  with no mode string means "auto" — but an EMPTY capture (pane vanished
 *  mid-read) stays null: unknown, never a guessed mode. */
export function modeFromPane(paneText: string): PermissionMode | null {
  if (!paneText.trim()) return null;
  return parsePermissionMode(paneText) ?? "auto";
}

/**
 * A "working" reading is suspect if the timer says a turn is running but the
 * transcript hasn't been written in a VERY long time — a live turn streams
 * block-lines to the transcript, so a lingering timer over a long-idle
 * transcript is likely a stale/misread signal (e.g. a completed-turn summary
 * line that kept a `(Ns · …)` segment → send button stuck as "stop").
 *
 * The threshold is deliberately generous (3 min): a legitimate long tool call
 * (a slow build) also shows timer-present + transcript-idle, so a short window
 * would false-positive on normal work. Only a genuinely stuck signal persists
 * past minutes. This catches the "stuck true" failure mode; the inverse (the
 * timer format changing so `working` reads FALSE always) can't be seen from
 * mtime and remains an inherent limit of an empirical signal.
 */
export const WORKING_DRIFT_IDLE_MS = 180_000;

/**
 * Drift guard: literal-keyed signals shift across Claude Code releases, and
 * their failure mode is SILENT mis-gating. Detects: the mode-cycle hint without
 * a recognizable mode string (mode pill dead), and — when `transcriptIdleMs` is
 * supplied — a stuck "working" timer over a long-idle transcript (see above).
 */
export function detectSignalDrift(
  paneText: string,
  transcriptIdleMs?: number,
): ("working" | "mode")[] {
  const drift: ("working" | "mode")[] = [];
  const foot = paneText
    .split("\n")
    .filter((l) => l.trim())
    .slice(-10)
    .join("\n");
  if (
    transcriptIdleMs !== undefined &&
    TURN_TIMER.test(foot) &&
    transcriptIdleMs > WORKING_DRIFT_IDLE_MS
  )
    drift.push("working");
  if (/shift\+tab to cycle/i.test(foot) && parsePermissionMode(paneText) === null)
    drift.push("mode");
  return drift;
}
