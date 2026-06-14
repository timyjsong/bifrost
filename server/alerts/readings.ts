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
  /** sessionId → epoch ms the session entered its current busy (not
   *  genuinely-done) stretch. Drives the session_done run-length floor. */
  busySince: Record<string, number>;
}

export const emptyDeriveState = (): DeriveState => ({ busySince: {} });

function sessionName(s: SessionInfo): string {
  return s.customTitle || s.title || basename(s.cwd) || s.sessionId.slice(0, 8);
}

function fmtG(kb: number): string {
  return `${(kb / 1024 / 1024).toFixed(1)}G`;
}

/**
 * A session is genuinely yours when its turn output is done AND nothing is
 * still running under it. `children` is the right list to check — it includes
 * re-attributed fanned-out agents (research / redteam swarms) that the state
 * machine's ps-tree `childProcs` count misses. Presence, not CPU: an agent
 * blocked on the network reads ~0% CPU but is very much alive.
 */
function genuinelyDone(s: SessionInfo): boolean {
  return s.state === "awaiting" && (s.children?.length ?? 0) === 0;
}

/**
 * The three per-session signals, derived in one pass so they share the
 * busy/done bookkeeping:
 *   session_done     — transition; fires once a session completes a run that
 *                      met the floor and is genuinely back on you.
 *   session_reminder — gauge on minutes-waiting; the recurring nag.
 *   session_approval — transition; a permission prompt blocking you (nothing
 *                      running behind it).
 * A per-card mute (`s.alertsEnabled === false`) emits no readings for that
 * session — its latch is then dropped by the engine, so a re-enable can't
 * false-fire on a stale edge. Bookkeeping still advances while muted.
 */
function sessionReadings(
  sessions: SessionInfo[],
  floorMin: number,
  prev: DeriveState,
  now: number,
): { readings: SignalReading[]; busySince: Record<string, number> } {
  const busy = { ...prev.busySince };
  const live = new Set<string>();
  const out: SignalReading[] = [];

  for (const s of sessions) {
    if (!s.live || s.headless) continue;
    live.add(s.sessionId);

    const done = genuinelyDone(s);
    // Track the current busy stretch: mark its start when busy, and on the tick
    // it finishes, measure how long it ran (for the floor) and clear it.
    let ranMin = 0;
    let justCompleted = false;
    if (!done) {
      if (busy[s.sessionId] === undefined) busy[s.sessionId] = now;
    } else {
      const since = busy[s.sessionId];
      if (since !== undefined) {
        ranMin = (now - since) / 60000;
        justCompleted = true;
        delete busy[s.sessionId];
      }
    }

    if (s.alertsEnabled === false) continue; // per-card mute

    const name = sessionName(s);
    const waitMin = done ? (now - s.lastActivityAt) / 60000 : 0;
    const atApproval = s.state === "approval" && (s.children?.length ?? 0) === 0;

    out.push({
      id: "session_done",
      instance: s.sessionId,
      active: justCompleted && ranMin >= floorMin,
      context: justCompleted ? `${name} finished after ${Math.round(ranMin)}m` : undefined,
    });
    out.push({
      id: "session_reminder",
      instance: s.sessionId,
      value: waitMin,
      context: done ? `${name} · waiting ${Math.round(waitMin)}m` : undefined,
    });
    out.push({
      id: "session_approval",
      instance: s.sessionId,
      active: atApproval,
      context: atApproval ? `${name} · waiting on a permission prompt` : undefined,
    });
  }
  for (const id of Object.keys(busy)) if (!live.has(id)) delete busy[id];
  return { readings: out, busySince: busy };
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
  const floorMin = policy.signals.session_done?.threshold ?? 2;
  const sr = sessionReadings(sessions, floorMin, prev, now);

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
    // Tier 2  (session_done / session_reminder / session_approval are
    // per-session — appended below)
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
    ...sr.readings,
  ];

  const next: DeriveState = {
    prevUptimeSec: system.uptimeSec,
    prevMemTotalKb: system.mem.totalKb,
    busySince: sr.busySince,
  };
  return { readings, next };
}
