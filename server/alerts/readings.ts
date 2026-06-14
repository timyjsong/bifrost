/**
 * Pure derivation: raw system state → the engine's per-signal readings.
 *
 * This is where the value math lives (swap %, PSI, load-per-core, waiting
 * minutes, run duration, reboot/resize edges) — kept pure and threaded with an
 * explicit tracker state so it's testable without a clock or the box. The engine
 * decides *whether* a reading fires; this decides *what each reading is*.
 */
import { basename } from "node:path";
import type { SessionInfo, SystemInfo } from "../../shared/types";
import type { AlertPolicy } from "../../shared/alerts";
import type { SignalReading } from "./engine";
import type { AlertSources } from "./sources";

export interface DeriveState {
  prevUptimeSec?: number;
  prevMemTotalKb?: number;
  /** sessionId → epoch ms the session entered "working", for long-run detection. */
  working: Record<string, number>;
}

export const emptyDeriveState = (): DeriveState => ({ working: {} });

function sessionName(s: SessionInfo): string {
  return s.customTitle || s.title || basename(s.cwd) || s.sessionId.slice(0, 8);
}

function fmtG(kb: number): string {
  return `${(kb / 1024 / 1024).toFixed(1)}G`;
}

/** One reading per live interactive session: active once it has been awaiting
 *  past the threshold. Per-session so each fires once and re-arms on its own. */
function sessionWaitingReadings(
  sessions: SessionInfo[],
  thresholdMin: number,
  now: number,
): SignalReading[] {
  const out: SignalReading[] = [];
  for (const s of sessions) {
    if (!s.live || s.headless) continue;
    const isWaiting = s.state === "awaiting" || s.state === "approval";
    const waitMin = isWaiting ? (now - s.lastActivityAt) / 60000 : 0;
    out.push({
      id: "session_waiting",
      instance: s.sessionId,
      active: isWaiting && waitMin >= thresholdMin,
      context: isWaiting ? `${sessionName(s)} · waiting ${Math.round(waitMin)}m` : undefined,
    });
  }
  return out;
}

function boxChanged(
  system: SystemInfo,
  prev: DeriveState,
): { active: boolean; context?: string } {
  if (prev.prevUptimeSec !== undefined && system.uptimeSec < prev.prevUptimeSec) {
    return { active: true, context: "box rebooted" };
  }
  if (prev.prevMemTotalKb !== undefined && system.mem.totalKb !== prev.prevMemTotalKb) {
    return { active: true, context: `RAM resized to ${fmtG(system.mem.totalKb)}` };
  }
  return { active: false };
}

/** Track working→finished transitions; flag the longest finished run over threshold. */
function longRun(
  sessions: SessionInfo[],
  policy: AlertPolicy,
  prev: DeriveState,
  now: number,
): { active: boolean; context?: string; working: Record<string, number> } {
  const work = { ...prev.working };
  const thresholdMs = (policy.signals.long_run_done?.threshold ?? 30) * 60000;
  const live = new Set<string>();
  let active = false;
  let context: string | undefined;
  let longest = 0;

  for (const s of sessions) {
    if (!s.live || s.headless) continue;
    live.add(s.sessionId);
    if (s.state === "working") {
      if (work[s.sessionId] === undefined) work[s.sessionId] = now;
      continue;
    }
    const since = work[s.sessionId];
    if (since !== undefined) {
      const dur = now - since;
      delete work[s.sessionId];
      if (dur >= thresholdMs && dur > longest) {
        longest = dur;
        active = true;
        context = `${sessionName(s)} finished after ${Math.round(dur / 60000)}m`;
      }
    }
  }
  for (const id of Object.keys(work)) if (!live.has(id)) delete work[id];
  return { active, context, working: work };
}

export function deriveReadings(
  sources: AlertSources,
  system: SystemInfo,
  sessions: SessionInfo[],
  policy: AlertPolicy,
  prev: DeriveState,
  now: number,
): { readings: SignalReading[]; next: DeriveState } {
  const loadPerCore = system.cores ? system.load[0] / system.cores : 0;
  const freePct = system.disk.totalKb
    ? (system.disk.freeKb / system.disk.totalKb) * 100
    : 100;
  const top = system.procs[0];
  const topCtx = top ? `top: ${top.command} (${fmtG(top.rssKb)})` : undefined;

  const box = boxChanged(system, prev);
  const lr = longRun(sessions, policy, prev, now);
  const waitThreshold = policy.signals.session_waiting?.threshold ?? 10;

  const readings: SignalReading[] = [
    // Tier 0
    { id: "oom_shed", counter: sources.oomKill, context: topCtx },
    { id: "ram_wall", counter: sources.ramWall, context: topCtx },
    // Tier 1
    {
      id: "mem_stall",
      value: sources.psiMemSome,
      context: `memory PSI ${sources.psiMemSome.toFixed(0)} (some avg10)`,
    },
    {
      id: "swap_ceiling",
      value: sources.swapPct,
      context: `swap ${sources.swapPct.toFixed(0)}% of cap`,
    },
    {
      id: "swap_fill",
      value: sources.swapPct,
      context: `swap rising — now ${sources.swapPct.toFixed(0)}% of cap`,
    },
    {
      id: "cpu_storm",
      value: loadPerCore,
      context: `load ${system.load[0].toFixed(2)} on ${system.cores} cores`,
    },
    // Tier 2  (session_waiting is per-session — appended below)
    {
      id: "service_down",
      active: sources.servicesDown.length > 0,
      context: sources.servicesDown.length ? `down: ${sources.servicesDown.join(", ")}` : undefined,
    },
    { id: "safeguard_health", active: !sources.limitsHealthy, context: sources.limitsReason },
    {
      id: "disk_low",
      value: freePct,
      context: `${fmtG(system.disk.freeKb)} free on /`,
    },
    // Tier 3
    { id: "box_changed", active: box.active, context: box.context },
    { id: "long_run_done", active: lr.active, context: lr.context },
    ...sessionWaitingReadings(sessions, waitThreshold, now),
  ];

  const next: DeriveState = {
    prevUptimeSec: system.uptimeSec,
    prevMemTotalKb: system.mem.totalKb,
    working: lr.working,
  };
  return { readings, next };
}
