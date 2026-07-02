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
  const ne: string[] = [];
  for (const raw of paneText.split("\n")) {
    const s = strip(raw);
    if (s) ne.push(s);
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
  // 2. A question line ("…?") within the 3 lines just above the options.
  let prompt = "";
  for (let j = runStart - 1; j >= 0 && j >= runStart - 3; j--) {
    if (ne[j].endsWith("?")) {
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

// The status bar shows "esc to interrupt" exactly while the MAIN turn is running
// (control not yet yours), and flips to "← for agents" the instant control returns
// — even with background shells/agents still going ("· N shells · ← for agents").
// So this marker is the precise "mid-processing" signal: true only while the turn
// is in flight, FALSE at soft idle (returned, bg work pending) and true idle alike.
// Verified live: present continuously through a turn, gone the instant it ends.
// (The older "(Ns · …)" elapsed-timer heuristic was dropped — it FLICKERED, absent
// at turn start and between thinking phases → false negatives, and a "N shell still
// running" line could read as work.)
const WORKING = /esc to interrupt/;

export function isPaneWorking(paneText: string): boolean {
  // the status bar is pinned at the foot of the pane; scan only the bottom region
  // so a stray "esc to interrupt" in transcript scrollback can't false-positive.
  const lines = paneText.split("\n").filter((l) => l.trim());
  return lines.slice(-6).some((l) => WORKING.test(l));
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
