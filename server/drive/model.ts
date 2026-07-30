/**
 * Model picker — parsing for the TUI's /model menu (chrome captured live
 * 2026-07-02, Claude Code v2.1.198):
 *
 *   Select model
 *   Switch between Claude models. Your pick becomes the default for new sessions. …
 *     1. Default (recommended)  Opus 4.8 with 1M context · Best for everyday, complex tasks
 *     2. Opus                   Opus 4.8 with 1M context · Best for everyday, complex tasks
 *   ❯ 5. Haiku ✔                Haiku 4.5 · Fastest for quick answers
 *   ○ Effort not supported for Haiku
 *   Enter to set as default · s to use this session only · Esc to cancel
 *
 * THE LOAD-BEARING SEMANTIC: Enter persists the pick as the ACCOUNT DEFAULT;
 * "s" applies it to this session only. Bifrost only ever presses "s" — the
 * account default is never touched from here. After "s" the TUI may show a
 * numbered "Switch model?" confirm (cache-cost warning); the route answers it.
 *
 * Best-effort by design: unparseable chrome returns null and the caller
 * surfaces the raw terminal — never a guessed keystroke.
 */

export interface ModelOption {
  /** Row label as rendered, ✔ stripped ("Default (recommended)", "Haiku"). */
  label: string;
  /** The description column ("Haiku 4.5 · Fastest for quick answers"). */
  detail: string;
  /** True on the row carrying the ✔ (the session's current model). */
  current: boolean;
}

export interface ModelMenu {
  options: ModelOption[]; // in rendered (numbered) order
  /** Cursor position: index into options. */
  cursorIndex: number;
}

const FOOTER = /s to use this session only/;
const HEADER = /^\s*Select model\s*$/;
const ROW = /^\s*(❯\s*)?(\d+)\.\s+(.*)$/;

export function parseModelMenu(paneText: string): ModelMenu | null {
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

  const options: ModelOption[] = [];
  let cursorIndex = -1;
  for (let i = headerIdx + 1; i < footerIdx; i++) {
    const m = lines[i].match(ROW);
    if (!m) continue; // description / warning lines aren't numbered rows
    const cursored = m[1] !== undefined;
    // Label column, then a 2+-space gap, then the detail column.
    const [labelRaw, ...rest] = m[3].split(/\s{2,}/);
    const current = /✔/.test(labelRaw);
    if (cursored) cursorIndex = options.length;
    options.push({
      label: labelRaw.replace(/✔/g, "").trim(),
      detail: rest.join(" ").trim(),
      current,
    });
  }
  if (!options.length || cursorIndex < 0) return null;
  return { options, cursorIndex };
}

/** The post-"s" cache-cost confirm ("Switch model? … 1. Yes … 2. No"). */
export function isModelConfirm(paneText: string): boolean {
  return /Switch model\?/.test(paneText);
}

/**
 * Resolve a peeked model choice against a freshly re-parsed picker by its label
 * (not the peek-time index, which can shift). Returns the row index, or -1 when
 * the label is no longer offered (the caller surfaces "no longer available").
 */
export function modelIndexByLabel(options: ModelOption[], label: string): number {
  return options.findIndex((o) => o.label === label);
}
