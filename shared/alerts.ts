/**
 * Alert domain — the signal catalog + the user-tunable policy shape.
 *
 * Shared between the server (detection + the pure engine) and the web dashboard
 * (the settings panel renders the catalog and edits the policy). This file is
 * the single source of truth for *what signals exist*; the engine
 * (server/alerts/engine.ts) is the single source of truth for *how they fire*.
 *
 * Decoupling is the point: adding a signal = a catalog entry here + a reading in
 * the manager. No engine change, no UI change.
 */

export type SignalId =
  // Tier 0 — the core safety net
  | "oom_shed"
  | "ram_wall"
  // Tier 1
  | "mem_stall"
  | "swap_ceiling"
  | "swap_fill"
  | "cpu_storm"
  // Tier 2
  | "session_waiting"
  | "service_down"
  | "safeguard_health"
  | "disk_low"
  // Tier 3
  | "box_changed"
  | "long_run_done";

/**
 * How the engine evaluates a signal's reading each tick:
 * - edge:       a monotonic counter; fire when it increases.
 * - gauge:      a numeric value vs the policy threshold, with hysteresis +
 *               sustain. `invert` makes it fire when the value drops *below*.
 * - rate:       value change per minute vs the threshold.
 * - transition: a discrete bad/good state; fire on entering the bad state.
 */
export type SignalKind = "edge" | "gauge" | "rate" | "transition";

export type Severity = "info" | "warn" | "crit";

export interface ThresholdMeta {
  min: number;
  max: number;
  step: number;
  unit: string;
  label: string; // what the slider controls, e.g. "PSI some avg10"
}

export interface SignalDef {
  id: SignalId;
  tier: 0 | 1 | 2 | 3;
  kind: SignalKind;
  severity: Severity;
  label: string;
  desc: string; // one line, shown under the toggle in the panel
  /** gauge/rate: the tunable threshold. edge/transition: omitted (no slider). */
  threshold?: ThresholdMeta;
  /** gauge only: fire when value drops below the threshold (e.g. disk free%). */
  invert?: boolean;
  /** gauge only: value must hold past the threshold this long before firing. */
  sustainSec?: number;
  // defaults — the starting policy; the user tunes live from the dashboard.
  defaultEnabled: boolean;
  defaultThreshold?: number;
  defaultCooldownSec: number;
}

/** The seed catalog (tiered). Defaults are a starting point — all tunable live. */
export const CATALOG: SignalDef[] = [
  // ---- Tier 0 — the core safety net -------------------------------------
  {
    id: "oom_shed",
    tier: 0,
    kind: "edge",
    severity: "crit",
    label: "OOM kill",
    desc: "The kernel OOM-reaper killed a process in your slice.",
    defaultEnabled: true,
    defaultCooldownSec: 60,
  },
  {
    id: "ram_wall",
    tier: 0,
    kind: "edge",
    severity: "crit",
    label: "RAM ceiling hit",
    desc: "user-1000.slice hit its memory.max wall (allocations refused).",
    defaultEnabled: true,
    defaultCooldownSec: 60,
  },
  // ---- Tier 1 -----------------------------------------------------------
  {
    id: "mem_stall",
    tier: 1,
    kind: "gauge",
    severity: "warn",
    label: "Memory stall",
    desc: "The box is crawling on memory (PSI pressure sustained).",
    threshold: { min: 10, max: 90, step: 5, unit: "%", label: "PSI some avg10" },
    sustainSec: 6,
    defaultEnabled: true,
    defaultThreshold: 40,
    defaultCooldownSec: 300,
  },
  {
    id: "swap_ceiling",
    tier: 1,
    kind: "gauge",
    severity: "warn",
    label: "Swap near ceiling",
    desc: "Swap usage is approaching its cap.",
    threshold: { min: 30, max: 95, step: 5, unit: "%", label: "swap.current / swap.max" },
    sustainSec: 0,
    defaultEnabled: true,
    defaultThreshold: 70,
    defaultCooldownSec: 300,
  },
  {
    id: "swap_fill",
    tier: 1,
    kind: "rate",
    severity: "warn",
    label: "Swap filling fast",
    desc: "Swap is rising quickly — a burst is incoming (early warning).",
    threshold: { min: 2, max: 50, step: 1, unit: "%/min", label: "swap fill rate" },
    defaultEnabled: true,
    defaultThreshold: 15,
    defaultCooldownSec: 300,
  },
  {
    id: "cpu_storm",
    tier: 1,
    kind: "gauge",
    severity: "warn",
    label: "CPU storm",
    desc: "Load is above the core count, sustained.",
    threshold: { min: 0.5, max: 4, step: 0.25, unit: "× cores", label: "load1 / cores" },
    sustainSec: 30,
    defaultEnabled: true,
    defaultThreshold: 1,
    defaultCooldownSec: 600,
  },
  // ---- Tier 2 -----------------------------------------------------------
  {
    id: "session_waiting",
    tier: 2,
    // Per-session edge: fires once when a session crosses the wait threshold,
    // re-arms only when that session stops waiting. The threshold is applied in
    // derivation (transitions don't compare); cooldown is an anti-flap floor.
    kind: "transition",
    severity: "info",
    label: "Session waiting for you",
    desc: "A live session has been awaiting your input a while.",
    threshold: { min: 1, max: 60, step: 1, unit: "min", label: "waiting longer than" },
    defaultEnabled: true,
    defaultThreshold: 10,
    defaultCooldownSec: 600,
  },
  {
    id: "service_down",
    tier: 2,
    kind: "transition",
    severity: "crit",
    label: "Service down",
    desc: "A critical unit stopped (tailscaled/sshd = access risk).",
    defaultEnabled: true,
    defaultCooldownSec: 120,
  },
  {
    id: "safeguard_health",
    tier: 2,
    kind: "transition",
    severity: "crit",
    label: "Safeguard unhealthy",
    desc: "claude-limits failed, its timer stalled, or a limit reverted to max.",
    defaultEnabled: true,
    defaultCooldownSec: 300,
  },
  {
    id: "disk_low",
    tier: 2,
    kind: "gauge",
    severity: "warn",
    label: "Disk low on /",
    desc: "Free space on the root filesystem is running out.",
    threshold: { min: 2, max: 50, step: 1, unit: "% free", label: "free space below" },
    invert: true,
    sustainSec: 0,
    defaultEnabled: true,
    defaultThreshold: 10,
    defaultCooldownSec: 1800,
  },
  // ---- Tier 3 -----------------------------------------------------------
  {
    id: "box_changed",
    tier: 3,
    kind: "transition",
    severity: "info",
    label: "Box rebooted / resized",
    desc: "Uptime reset or total RAM changed.",
    defaultEnabled: true,
    defaultCooldownSec: 60,
  },
  {
    id: "long_run_done",
    tier: 3,
    kind: "transition",
    severity: "info",
    label: "Long run finished",
    desc: "A long-lived session went from working to waiting.",
    threshold: { min: 5, max: 120, step: 5, unit: "min", label: "run longer than" },
    defaultEnabled: true,
    defaultThreshold: 30,
    defaultCooldownSec: 300,
  },
];

/** The user-tunable knobs per signal — exactly what the dashboard edits. */
export interface SignalPolicy {
  enabled: boolean;
  threshold?: number;
  cooldownSec: number;
}

export interface AlertPolicy {
  signals: Record<string, SignalPolicy>;
}

export function defaultPolicy(): AlertPolicy {
  const signals: Record<string, SignalPolicy> = {};
  for (const def of CATALOG) {
    signals[def.id] = {
      enabled: def.defaultEnabled,
      threshold: def.defaultThreshold,
      cooldownSec: def.defaultCooldownSec,
    };
  }
  return { signals };
}

/**
 * Merge a saved policy over the catalog defaults: a newly-added signal picks up
 * its default, a saved override wins, a stale signal id is dropped. Pure — the
 * store and the panel both reconcile through this.
 */
export function mergePolicy(saved: Partial<AlertPolicy> | null | undefined): AlertPolicy {
  const base = defaultPolicy();
  const savedSignals = saved?.signals ?? {};
  for (const def of CATALOG) {
    const s = savedSignals[def.id];
    if (!s) continue;
    base.signals[def.id] = {
      enabled: typeof s.enabled === "boolean" ? s.enabled : base.signals[def.id].enabled,
      threshold: typeof s.threshold === "number" ? s.threshold : base.signals[def.id].threshold,
      cooldownSec:
        typeof s.cooldownSec === "number" ? s.cooldownSec : base.signals[def.id].cooldownSec,
    };
  }
  return base;
}
