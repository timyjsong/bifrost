/**
 * Channel 3 — the permission-menu parser. Pure (pane text in → menu out), so the
 * brittle bit (TUI chrome shifts across Claude Code versions) is isolated and
 * tested. This is best-effort by design: when it returns null the UI does NOT
 * guess — it shows the raw pane and routes you to the prompt box / raw terminal
 * (the loud fallback, AC5.3). A wrong auto-answer is the one outcome we refuse.
 *
 * Format assumption (to be confirmed against a LIVE prompt at review): the
 * permission dialog renders a question line ending in "?", then numbered choices
 * "1. Yes …", "2. …", "3. No …", optionally inside a box-drawing frame with a
 * "❯" cursor on the selected row. We key on a run of sequentially-numbered
 * options starting at 1 — strong enough to ignore incidental numbered text.
 */
import type { PermissionMenu } from "../../shared/types";
export type { PermissionMenu };

// Strip box-drawing borders / cursor glyphs / padding so the option text is bare.
function strip(s: string): string {
  return s.replace(/[│|╭╮╰╯─━┃┏┓┗┛▌▐]/g, " ").replace(/[❯>›▶]/g, " ").trim();
}

const OPTION = /^(\d+)\.\s+(.*\S)\s*$/;

export function parsePermissionMenu(paneText: string): PermissionMenu | null {
  const lines = paneText.split("\n").map(strip);
  const options: { key: string; label: string }[] = [];
  let expect = 1;
  let recentQuestion = "";
  let prompt = "";

  for (const line of lines) {
    const m = line.match(OPTION);
    if (m && Number(m[1]) === expect) {
      if (expect === 1) prompt = recentQuestion; // freeze the question at menu start
      options.push({ key: m[1], label: m[2].trim() });
      expect++;
    } else if (m && Number(m[1]) === 1) {
      // a fresh "1." — restart on the later menu (panes can hold a stale one)
      options.length = 0;
      options.push({ key: "1", label: m[2].trim() });
      prompt = recentQuestion;
      expect = 2;
    } else if (!m && line.endsWith("?") && line.length > 3) {
      recentQuestion = line;
    }
    // non-option, non-question lines (blanks, borders) don't break a run:
    // `expect` is unchanged, so padding between options is tolerated.
  }

  if (options.length < 2) return null; // a real prompt has at least Yes + No
  return { prompt: prompt || "Permission requested", options };
}

/** A menu answer is a single digit (a numbered choice) or Enter (accept default).
 *  Anything else is rejected — the answer surface stays deliberately tiny. */
export function isValidAnswerKey(key: string): boolean {
  return /^[1-9]$/.test(key) || key === "Enter";
}
