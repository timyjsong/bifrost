/**
 * Pure session filtering: residence, model family, and idle-age cutoffs.
 * Kept out of React and the views so it's unit-testable and the filter bar
 * stays a thin control. Applied to the full live-session list before
 * grouping, so every group (needs-you, working, headless) narrows together.
 */
import type { SessionInfo } from "../../../shared/types";

export type Residence = "tmux" | "ssh" | "desktop" | "terminal" | "other";
export type ModelFamily = "fable" | "opus" | "sonnet" | "haiku" | "other";

export interface SessionFilters {
  residence: Residence | "all";
  model: ModelFamily | "all";
  /** hide sessions whose last activity is older than this many ms; null = no cutoff */
  maxIdleMs: number | null;
}

export const NO_FILTERS: SessionFilters = {
  residence: "all",
  model: "all",
  maxIdleMs: null,
};

export function isFiltering(f: SessionFilters): boolean {
  return f.residence !== "all" || f.model !== "all" || f.maxIdleMs !== null;
}

/** Where a session runs — most specific wins, mirroring the residence chip. */
export function residenceOf(s: SessionInfo): Residence {
  if (s.tmuxSession) return "tmux";
  if (s.overSsh) return "ssh";
  if (s.entrypoint === "claude-desktop") return "desktop";
  if (s.entrypoint === "cli") return "terminal";
  return "other";
}

/** Model family from the resolved model id. */
export function modelFamily(s: SessionInfo): ModelFamily {
  const m = s.model ?? "";
  if (/fable/i.test(m)) return "fable";
  if (/opus/i.test(m)) return "opus";
  if (/sonnet/i.test(m)) return "sonnet";
  if (/haiku/i.test(m)) return "haiku";
  return "other";
}

export function matchesFilters(
  s: SessionInfo,
  f: SessionFilters,
  now: number,
): boolean {
  if (f.residence !== "all" && residenceOf(s) !== f.residence) return false;
  if (f.model !== "all" && modelFamily(s) !== f.model) return false;
  if (f.maxIdleMs !== null && now - s.lastActivityAt > f.maxIdleMs) return false;
  return true;
}

export function applyFilters(
  sessions: SessionInfo[],
  f: SessionFilters,
  now: number,
): SessionInfo[] {
  if (!isFiltering(f)) return sessions;
  return sessions.filter((s) => matchesFilters(s, f, now));
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Idle-cutoff presets for the filter bar (label → ms, null = any). */
export const IDLE_PRESETS: { label: string; value: number | null }[] = [
  { label: "any", value: null },
  { label: "< 1h", value: HOUR },
  { label: "< 6h", value: 6 * HOUR },
  { label: "< 1d", value: DAY },
  { label: "< 3d", value: 3 * DAY },
  { label: "< 7d", value: 7 * DAY },
];

export const RESIDENCE_OPTS: (Residence | "all")[] = [
  "all",
  "tmux",
  "ssh",
  "desktop",
  "terminal",
];

export const MODEL_OPTS: (ModelFamily | "all")[] = [
  "all",
  "fable",
  "opus",
  "sonnet",
  "haiku",
];
