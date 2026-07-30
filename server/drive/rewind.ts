/**
 * Rewind (checkpoints) — parsing + navigation math for the TUI's Esc-Esc
 * rewind picker (chrome captured live 2026-07-02):
 *
 *   Rewind
 *   Restore the code and/or conversation to the point before…
 *     Say only TURN-ONE.
 *     No code changes
 *   ❯ Say only TURN-TWO.
 *     No code changes
 *     (current)
 *   Enter to continue · Esc to cancel
 *
 * Checkpoints render as prompt-line + change-detail pairs, ending with a
 * "(current)" row; the ❯ cursor marks the selected row. Selecting a
 * checkpoint (arrows + Enter) opens a NUMBERED confirm menu that the existing
 * pane-menu machinery parses and answers. Best-effort by design: unparseable
 * chrome returns null and the caller surfaces "use the raw terminal" — never
 * a guessed keystroke.
 */

export interface RewindCheckpoint {
  /** The user prompt this checkpoint precedes (the picker's row label). */
  label: string;
  /** The change-detail line under it ("No code changes", diff stat, …). */
  detail: string;
}

export interface RewindMenu {
  checkpoints: RewindCheckpoint[]; // oldest-first, as rendered
  /** Cursor position: index into checkpoints, or checkpoints.length for "(current)". */
  cursorIndex: number;
}

const FOOTER = /Enter to continue/;
const HEADER = /^\s*❯?\s*Rewind\s*$/;

export function parseRewindMenu(paneText: string): RewindMenu | null {
  const lines = paneText.split("\n");
  let headerIdx = -1;
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (footerIdx < 0 && FOOTER.test(lines[i])) footerIdx = i;
    else if (footerIdx >= 0 && HEADER.test(lines[i].replace(/[│╭╮╰╯─━]/g, " "))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0 || footerIdx < 0 || footerIdx <= headerIdx) return null;

  // Rows between header and footer, skipping the description line(s) that end
  // with "…". Each checkpoint is a (label, detail) pair; "(current)" ends the list.
  const rows: { text: string; cursored: boolean }[] = [];
  for (let i = headerIdx + 1; i < footerIdx; i++) {
    const raw = lines[i];
    const cursored = /❯/.test(raw);
    const text = raw.replace(/[❯│╭╮╰╯─━]/g, " ").trim();
    if (!text || text.endsWith("…")) continue;
    rows.push({ text, cursored });
  }
  if (!rows.length) return null;

  const checkpoints: RewindCheckpoint[] = [];
  let cursorIndex = -1;
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (/^\(current\)$/.test(row.text)) {
      if (row.cursored) cursorIndex = checkpoints.length;
      i++;
      continue;
    }
    const detail = i + 1 < rows.length && !/^\(current\)$/.test(rows[i + 1].text)
      ? rows[i + 1].text
      : "";
    if (row.cursored || (detail && rows[i + 1]?.cursored)) {
      cursorIndex = checkpoints.length;
    }
    checkpoints.push({ label: row.text, detail });
    i += detail ? 2 : 1;
  }
  if (!checkpoints.length || cursorIndex < 0) return null;
  return { checkpoints, cursorIndex };
}

/**
 * Resolve a peeked checkpoint against a freshly re-parsed picker by its identity
 * (label + detail), not the peek-time index — the list can grow between peek and
 * commit as new turns add checkpoints. Rewind is DESTRUCTIVE, so this refuses to
 * guess: a unique (label, detail) match returns its index; zero matches OR more
 * than one (ambiguous) returns -1, and the caller declines rather than restore to
 * the wrong point.
 */
export function rewindIndexByIdentity(
  checkpoints: RewindCheckpoint[],
  id: { label: string; detail: string },
): number {
  let found = -1;
  for (let i = 0; i < checkpoints.length; i++) {
    if (checkpoints[i].label === id.label && checkpoints[i].detail === id.detail) {
      if (found !== -1) return -1; // ambiguous — never guess on a destructive op
      found = i;
    }
  }
  return found;
}
