/**
 * Pure data shaping for the sessions display: partitioning, ordering, column
 * packing, queue status. Views consume these — no view imports collectors,
 * no selector imports React. This is the seam that makes the visual layer
 * swappable.
 */
import type { SessionInfo, Snapshot } from "../../../shared/types";

export interface SessionGroups {
  /** Live, interactive, awaiting/approval — longest wait first. */
  needsYou: SessionInfo[];
  /** Live, interactive, working/paused — most recent activity first. */
  working: SessionInfo[];
  liveHeadless: SessionInfo[];
}

export function groupSessions(sessions: SessionInfo[]): SessionGroups {
  const liveInteractive = sessions.filter((s) => s.live && !s.headless);
  return {
    needsYou: liveInteractive
      .filter((s) => s.state === "awaiting" || s.state === "approval")
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt),
    working: liveInteractive.filter(
      (s) => s.state !== "awaiting" && s.state !== "approval",
    ),
    liveHeadless: sessions.filter((s) => s.live && s.headless),
  };
}

/**
 * Distribute into n independently-packed stacks (round-robin), so an expanded
 * card only pushes its own column — grid rows would couple heights.
 */
export function splitColumns<T>(list: T[], cols: number): T[][] {
  if (cols <= 1) return [list];
  const out: T[][] = Array.from({ length: cols }, () => []);
  list.forEach((item, i) => out[i % cols].push(item));
  return out;
}

/**
 * Whether session alerts fire for this session. Mirrors the server's per-card
 * mute contract (`server/index.ts` / `alerts/readings.ts`): the flag is absent
 * by default and only an explicit `false` mutes — so undefined reads as on.
 * Single-sourced here so every view's mute toggle agrees.
 */
export function sessionAlertsEnabled(s: SessionInfo): boolean {
  return s.alertsEnabled !== false;
}

export type QueueStatus = "queued" | "active" | undefined;

export function queueStatusOf(
  sessionId: string,
  summarize: Snapshot["summarize"],
): QueueStatus {
  if (summarize?.active.includes(sessionId)) return "active";
  if (summarize?.queued.includes(sessionId)) return "queued";
  return undefined;
}
