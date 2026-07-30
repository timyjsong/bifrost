/**
 * Effort slider — parsing for the TUI's /effort picker (chrome captured live
 * 2026-07-02, Claude Code v2.1.198):
 *
 *   Effort
 *          Faster                                                 Smarter
 *          ──────────────────────────────▲────────────┆──────────────────
 *          low     medium     high     xhigh      max       ultracode
 *                                                       xhigh + workflows
 *   ←/→ to adjust · Enter to confirm · Esc to cancel
 *
 * A SLIDER, not a row menu: ▲ marks the session's current stop (matched to the
 * nearest label center by column); the ┆ tick is a fixed zone separator before
 * ultracode, not a selection. ←/→ moves one stop; Enter confirms. Verified
 * live: Enter is session-scoped — the account settings file is untouched.
 *
 * Best-effort by design: unparseable chrome returns null and the caller
 * surfaces the raw terminal — never a guessed keystroke.
 */

export interface EffortSlider {
  options: string[]; // stop labels, left→right ("low" … "ultracode")
  /** ▲'s stop: index into options. */
  currentIndex: number;
}

const FOOTER = /←\/→ to adjust/;
const HEADER = /^\s*Effort\s*$/;

/**
 * Resolve a peeked effort choice against a freshly re-parsed slider by its stop
 * label (not the peek-time index). Returns the stop index, or -1 when that stop
 * is no longer offered.
 */
export function effortIndexByValue(options: string[], value: string): number {
  return options.indexOf(value);
}

export function parseEffortSlider(paneText: string): EffortSlider | null {
  const lines = paneText.split("\n");
  let headerIdx = -1;
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (footerIdx < 0 && FOOTER.test(lines[i])) footerIdx = i;
    else if (footerIdx >= 0 && HEADER.test(lines[i].replace(/[│╭╮╰╯]/g, " "))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0 || footerIdx < 0 || footerIdx <= headerIdx) return null;

  let trackIdx = -1;
  for (let i = headerIdx + 1; i < footerIdx; i++) {
    if (lines[i].includes("▲")) {
      trackIdx = i;
      break;
    }
  }
  if (trackIdx < 0) return null;

  // The stop labels are the first non-empty line under the track (the
  // "xhigh + workflows" sub-caption and any warning sit further down).
  let labelsLine = "";
  for (let i = trackIdx + 1; i < footerIdx; i++) {
    if (lines[i].trim()) {
      labelsLine = lines[i];
      break;
    }
  }
  if (!labelsLine) return null;

  const cursor = lines[trackIdx].indexOf("▲");
  const stops: { label: string; center: number }[] = [];
  for (const m of labelsLine.matchAll(/\S+/g)) {
    stops.push({ label: m[0], center: (m.index ?? 0) + m[0].length / 2 });
  }
  if (!stops.length) return null;

  let currentIndex = 0;
  let best = Infinity;
  stops.forEach((s, i) => {
    const d = Math.abs(s.center - cursor);
    if (d < best) {
      best = d;
      currentIndex = i;
    }
  });
  return { options: stops.map((s) => s.label), currentIndex };
}
