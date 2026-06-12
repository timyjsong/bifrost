/**
 * Pure view-model logic for session cards — extracted from CardsView so the
 * behavior is unit-testable and classification stays single-sourced with the
 * filter helpers (residenceOf / modelFamily). Views render; this decides.
 */
import type { SessionInfo, ChildProc } from "../../../shared/types";
import { modelFamily, type ModelFamily } from "./sessionFilters";

export interface ChildGroup {
  c: ChildProc; // representative (first seen)
  n: number; // processes folded into this line
  rssKb: number; // summed across the group
  cpu: number; // summed across the group (box-share %)
}

/**
 * Identical task names (e.g. a fan-out of same-prompt agents) fold into one
 * line with a ×N count and aggregated footprint. Unnamed children are always
 * distinct work — they never fold.
 */
export function groupChildren(children: ChildProc[]): ChildGroup[] {
  const groups = new Map<string, ChildGroup>();
  for (const c of children) {
    const key = c.name ?? `pid-${c.pid}`;
    const g = groups.get(key);
    if (g) {
      g.n += 1;
      g.rssKb += c.rssKb;
      g.cpu += c.cpu;
    } else {
      groups.set(key, { c, n: 1, rssKb: c.rssKb, cpu: c.cpu });
    }
  }
  return [...groups.values()];
}

export interface GaugeModel {
  window: number;
  measured: boolean; // false = window is a default/lookup, render with "~"
  ratio: number; // 0..1, clamped — usage can't render past the window
  danger: boolean; // past the 75% line
}

/** Context gauge semantics; null when the session has no usage data yet. */
export function gaugeModel(s: SessionInfo): GaugeModel | null {
  if (s.contextTokens === undefined) return null;
  const window = s.contextWindow ?? 200_000;
  const measured =
    s.contextWindowSrc !== undefined && s.contextWindowSrc !== "lookup";
  const ratio = Math.min(1, s.contextTokens / window);
  return { window, measured, ratio, danger: ratio > 0.75 };
}

/** Window denominator label: exact sizes read clean ("1M", "200K"). */
export function fmtWindow(window: number): string {
  return window >= 1_000_000 ? `${window / 1_000_000}M` : `${window / 1_000}K`;
}

export type StripeTone = "danger" | "gold" | "mute" | "auto";

/** State accent stripe: approval = danger, awaiting = gold, paused = mute,
 *  anything else live = working (auto violet). */
export function stateStripe(s: SessionInfo): StripeTone {
  if (s.state === "approval") return "danger";
  if (s.state === "awaiting") return "gold";
  if (s.state === "paused") return "mute";
  return "auto";
}

/** Model-family glyph for the pill — keyed by the same classification the
 *  model filter uses, so the pill and the filter can never disagree. */
export const FAMILY_GLYPHS: Record<ModelFamily, { glyph: string; cls: string }> = {
  fable: { glyph: "◆", cls: "text-gold" },
  opus: { glyph: "●", cls: "text-opus" },
  sonnet: { glyph: "▲", cls: "text-sonnet" },
  haiku: { glyph: "○", cls: "text-haiku" },
  other: { glyph: "·", cls: "text-ink-mute" },
};

export function glyphForModel(model: string): { glyph: string; cls: string } {
  return FAMILY_GLYPHS[modelFamily({ model } as SessionInfo)];
}
