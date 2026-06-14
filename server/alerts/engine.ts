/**
 * The pure alert engine: (readings, policy, prev-state, now) → (alerts, next-state).
 *
 * No I/O, no clock, no fs — every input is passed in, so the whole edge/threshold/
 * cooldown contract is unit-testable. The manager feeds it readings derived from
 * each system poll and ships whatever it returns.
 *
 * Firing rules by kind (see shared/alerts.ts):
 *   edge       — counter increased since last tick.
 *   gauge      — value held past the threshold for `sustainSec`; a 15% hysteresis
 *                band keeps a brief dip from resetting the sustain timer. `invert`
 *                flips the comparison (fire when value drops below).
 *   rate       — value rose by ≥ threshold per minute.
 *   transition — entered the bad state (false → true).
 * Every fire is then gated by the per-signal cooldown.
 */
import {
  CATALOG,
  type AlertPolicy,
  type Severity,
  type SignalDef,
  type SignalId,
} from "../../shared/alerts";

/** What the manager observes for one signal this tick. */
export interface SignalReading {
  id: SignalId;
  /** Per-entity key (e.g. a session id) when one signal tracks N things at once.
   *  State is latched per (id, instance); each instance fires/collapses on its own. */
  instance?: string;
  counter?: number; // edge: a monotonic count
  value?: number; // gauge / rate: a numeric gauge
  active?: boolean; // transition: in the bad state right now
  context?: string; // enrichment → the notification body
}

export interface PerSignalState {
  lastFiredAt?: number;
  prevCounter?: number; // edge
  aboveSince?: number; // gauge sustain timer
  prevValue?: number; // rate
  prevAt?: number; // rate
  prevActive?: boolean; // transition
}

export type EngineState = Record<string, PerSignalState>;

export interface FiredAlert {
  id: SignalId;
  tier: number;
  severity: Severity;
  title: string;
  body: string;
  tag: string;
}

const DEFS = new Map<SignalId, SignalDef>(CATALOG.map((d) => [d.id, d]));
const HYST = 0.15; // gauge re-arm hysteresis band (15% of threshold)

const stateKey = (r: SignalReading): string =>
  r.instance ? `${r.id}::${r.instance}` : r.id;

export function evaluate(
  readings: SignalReading[],
  policy: AlertPolicy,
  prev: EngineState,
  now: number,
): { fired: FiredAlert[]; next: EngineState } {
  const next: EngineState = { ...prev };
  const fired: FiredAlert[] = [];

  for (const reading of readings) {
    const key = stateKey(reading);
    const def = DEFS.get(reading.id);
    const pol = policy.signals[reading.id]; // policy/def resolve by base id
    const st: PerSignalState = { ...(prev[key] ?? {}) };
    next[key] = st;

    if (!def || !pol || !pol.enabled) {
      // Advance the baseline so a later enable doesn't false-fire on a stale edge.
      advanceBaseline(def, reading, st, now);
      continue;
    }

    const trig = triggers(def, pol.threshold, reading, st, now);
    if (!trig) continue;

    const cooldownMs = (pol.cooldownSec ?? def.defaultCooldownSec) * 1000;
    if (st.lastFiredAt !== undefined && now - st.lastFiredAt < cooldownMs) continue;

    st.lastFiredAt = now;
    fired.push(compose(def, reading));
  }

  // Drop per-instance state whose entity is gone this tick (e.g. a closed
  // session), so the latch map can't grow without bound.
  const live = new Set(readings.map(stateKey));
  for (const k of Object.keys(next)) {
    if (k.includes("::") && !live.has(k)) delete next[k];
  }

  return { fired, next };
}

/** Decide whether the signal fires this tick, advancing per-signal state in place. */
function triggers(
  def: SignalDef,
  threshold: number | undefined,
  r: SignalReading,
  st: PerSignalState,
  now: number,
): boolean {
  const t = threshold ?? def.defaultThreshold ?? 0;
  switch (def.kind) {
    case "edge": {
      const c = r.counter ?? 0;
      const prev = st.prevCounter;
      st.prevCounter = c;
      return prev !== undefined && c > prev;
    }
    case "transition": {
      const a = !!r.active;
      const prev = st.prevActive;
      st.prevActive = a;
      return prev === false && a; // entering bad state; first observation can't fire
    }
    case "rate": {
      const v = r.value ?? 0;
      const pv = st.prevValue;
      const pa = st.prevAt;
      st.prevValue = v;
      st.prevAt = now;
      if (pv === undefined || pa === undefined) return false;
      const dtMin = (now - pa) / 60000;
      if (dtMin <= 0) return false;
      return (v - pv) / dtMin >= t;
    }
    case "gauge": {
      const v = r.value ?? 0;
      const sustainMs = (def.sustainSec ?? 0) * 1000;
      const over = def.invert ? v <= t : v >= t;
      if (over) {
        if (st.aboveSince === undefined) st.aboveSince = now;
        return now - st.aboveSince >= sustainMs;
      }
      const clearFloor = def.invert ? t * (1 + HYST) : t * (1 - HYST);
      const cleared = def.invert ? v > clearFloor : v < clearFloor;
      if (cleared) st.aboveSince = undefined;
      // inside the hysteresis band: hold the sustain timer, don't fire
      return false;
    }
  }
}

function advanceBaseline(
  def: SignalDef | undefined,
  r: SignalReading,
  st: PerSignalState,
  now: number,
): void {
  if (!def) return;
  if (def.kind === "edge") st.prevCounter = r.counter ?? st.prevCounter;
  else if (def.kind === "transition") st.prevActive = !!r.active;
  else if (def.kind === "rate") {
    st.prevValue = r.value;
    st.prevAt = now;
  } else if (def.kind === "gauge") st.aboveSince = undefined;
}

function compose(def: SignalDef, r: SignalReading): FiredAlert {
  return {
    id: def.id,
    tier: def.tier,
    severity: def.severity,
    title: def.label,
    body: r.context?.trim() || def.desc,
    // collapse-key: a repeat replaces, doesn't stack. Per-instance signals get a
    // distinct key per entity, so two waiting sessions are two notifications.
    tag: r.instance ? `${def.id}:${r.instance}` : def.id,
  };
}
