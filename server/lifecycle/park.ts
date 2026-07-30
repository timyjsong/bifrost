/**
 * Idle-park — the decision layer (SESSION-LIFECYCLE-PLAN §3, built after the
 * §5 Phase-1 losslessness gate passed: audit/idle-park-phase1.md). PURE: every
 * kill decision is a tested, side-effect-free verdict over injected signals;
 * the sweeper carries out verdicts and owns all IO.
 *
 * The four idle conditions (ALL must hold — §3.1-.4; CPU-idle alone is not
 * sufficient), plus the rollout guards (§5/§8):
 *  - the session is parked at the input prompt: settled "awaiting", not
 *    working, and no queued operation after the last completed turn (a queued
 *    message DIES on park — proven, phase-1 Test B);
 *  - idle past the window (transcript last-activity age);
 *  - no live child processes (subagents, shells — §3.4, via attribution);
 *  - no in-flight background job for this uuid (§3.2, ~/.claude/jobs).
 * Armed kills apply ONLY to Bifrost-spawned sessions; everything else is
 * observe-only regardless of arming (blast-radius guard until I review it).
 */

export interface ParkSignals {
  live: boolean;
  bifrostSpawned: boolean;
  state: string; // derived session state — "awaiting" is the parked-at-prompt shape
  working: boolean; // pane working reading (held)
  lastActivityAt: number; // transcript mtime, epoch ms
  childProcs: number;
  hasInflightJob: boolean;
  hasQueuedOp: boolean;
}

export type ParkVerdict =
  | { park: true; mode: "kill" | "observe" }
  | { park: false; reason: string };

export function decidePark(
  s: ParkSignals,
  now: number,
  cfg: { idleParkMs: number; enabled: boolean },
): ParkVerdict {
  if (!s.live) return { park: false, reason: "not-live" };
  if (s.working) return { park: false, reason: "working" };
  if (s.state !== "awaiting") return { park: false, reason: `state:${s.state}` };
  if (s.childProcs > 0) return { park: false, reason: "children" };
  if (s.hasInflightJob) return { park: false, reason: "inflight-job" };
  if (s.hasQueuedOp) return { park: false, reason: "queued-op" };
  const idleMs = now - s.lastActivityAt;
  if (idleMs < cfg.idleParkMs) return { park: false, reason: "not-idle-long-enough" };
  // Verdict: park. Armed kill only for Bifrost-spawned sessions with the
  // feature enabled; everything else logs what it WOULD do (§5 Phase 0).
  return { park: true, mode: cfg.enabled && s.bifrostSpawned ? "kill" : "observe" };
}

/**
 * Cap the kills a single sweep may perform (§8: a watcher bug must not
 * mass-kill). Observe verdicts pass through untouched; kill verdicts beyond
 * the cap are demoted to observe.
 */
export function capKills<T extends { verdict: ParkVerdict }>(
  items: T[],
  maxKills: number,
): T[] {
  let kills = 0;
  return items.map((it) => {
    if (it.verdict.park && it.verdict.mode === "kill") {
      kills++;
      if (kills > maxKills) {
        return { ...it, verdict: { park: true, mode: "observe" as const } };
      }
    }
    return it;
  });
}
