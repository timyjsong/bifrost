/**
 * Dynamic memory gate — the pre-spawn resource control. There is NO static
 * concurrency cap and NO per-pane MemoryMax; the only cap in the cgroup hierarchy is
 * the shared user slice, whose memory.max covers every process the user owns
 * (~2.85 GiB on the box this was measured against — spike-1).
 * This gate protects THAT shared budget by deciding, from live slice headroom,
 * whether a fresh spawn may proceed.
 *
 * The decision (AC4.5) is a PURE function over INJECTED readings: the slice's
 * `memory.current` vs `memory.max`, plus the set of Bifrost-tracked sessions with
 * their memory + idle state. The cgroup read is a thin adapter (readSliceMemory)
 * that feeds those numbers in; all branching logic lives here, tested at each band
 * boundary. Bands by used ratio (current / max):
 *   - used ≥ hardFloor  ⇒ block  (over the hard floor — refuse the spawn)
 *   - used ≥ caution    ⇒ warn   (caution band — warn but allow)
 *   - else              ⇒ ok
 *
 * On block (AC4.6) the result names the heaviest IDLE Bifrost-tracked session to
 * close, so the caller can say exactly what to free.
 */
import { readFile } from "node:fs/promises";
import { userSlicePath } from "../config";

/** A live reading of the shared user slice's memory cgroup (bytes). */
export interface SliceReading {
  current: number; // memory.current
  max: number; // memory.max (the hard cap; the slice's MemoryMax)
  /** Reclaimable page cache (inactive_file + active_file). Subtracted from current
   *  so the gate keys on the working set, not evictable cache. Absent ⇒ treated as 0
   *  (the conservative pre-fix behaviour). */
  reclaimable?: number;
}

/** A system-wide memory reading (from /proc/meminfo, via the system collector).
 *  The fallback budget when the user slice has NO cap — the stock-Linux default,
 *  where a per-user `MemoryMax` is absent, so `memory.max` reads `"max"`. */
export interface SystemMemory {
  totalKb: number;
  availKb: number;
}

/** A Bifrost-tracked session's memory footprint + activity, for block-time selection. */
export interface TrackedSession {
  uuid: string;
  /** Resident memory attributed to this session (bytes). */
  memoryBytes: number;
  /** Whether the session is idle (a safe close candidate). */
  idle: boolean;
}

/** Band thresholds as used-ratio fractions of `max`. Injectable for testing/tuning. */
export interface MemGateBands {
  /** used ≥ this ⇒ block. */
  hardFloor: number;
  /** used ≥ this (and < hardFloor) ⇒ warn. */
  caution: number;
}

/**
 * Defaults: block once the shared slice is ≥ 90% used (headroom under ~285 MiB on a
 * 2.85 GiB cap — too little for a fresh claude), warn from 75% up. Tunable via the
 * `bands` arg; the boundaries are inclusive on the lower edge (used == threshold
 * lands in the higher-severity band).
 */
export const DEFAULT_BANDS: MemGateBands = { hardFloor: 0.9, caution: 0.75 };

export type GateDecision =
  | { band: "ok"; usedRatio: number }
  | { band: "warn"; usedRatio: number }
  | {
      band: "block";
      usedRatio: number;
      /** Heaviest idle tracked session to close, or null if none is idle. */
      closeCandidate: TrackedSession | null;
    };

/**
 * Pick the heaviest IDLE tracked session — the one to suggest closing on block
 * (AC4.6). Only idle sessions are candidates (closing an active one would interrupt
 * work); among them, the largest `memoryBytes` frees the most. Ties resolve to the
 * first seen (stable). Returns null when no tracked session is idle.
 */
export function heaviestIdleSession(
  sessions: readonly TrackedSession[],
): TrackedSession | null {
  let pick: TrackedSession | null = null;
  for (const s of sessions) {
    if (!s.idle) continue;
    if (pick === null || s.memoryBytes > pick.memoryBytes) pick = s;
  }
  return pick;
}

/**
 * The pure gate decision (AC4.5). `usedRatio = (current − reclaimable) / max` — the
 * working set over the cap, so evictable page cache doesn't read as pressure (raw
 * memory.current counts it, which made the gate refuse spawns with real headroom).
 *
 * When the slice has a cap (`max > 0`) that's the budget. When it does NOT — the
 * stock-Linux default, no per-user `MemoryMax`, `memory.max` == `"max"` → max 0 —
 * blocking outright would brick originate on every default host (a stranger can't
 * start a single session). So a `systemFallback` reading protects the SYSTEM budget
 * instead: `used = (total − available) / total`. Only with NO signal at all (no cap
 * AND no system reading) does it fail closed. On block it attaches the heaviest idle
 * session to close (AC4.6).
 */
export function decideMemoryGate(
  reading: SliceReading,
  sessions: readonly TrackedSession[] = [],
  bands: MemGateBands = DEFAULT_BANDS,
  systemFallback?: SystemMemory,
): GateDecision {
  let usedRatio: number;
  if (reading.max > 0) {
    const effective = Math.max(0, reading.current - (reading.reclaimable ?? 0));
    usedRatio = effective / reading.max;
  } else if (systemFallback && systemFallback.totalKb > 0) {
    usedRatio =
      (systemFallback.totalKb - systemFallback.availKb) / systemFallback.totalKb;
  } else {
    usedRatio = 1; // no cap AND no system reading — fail closed
  }
  if (usedRatio >= bands.hardFloor) {
    return { band: "block", usedRatio, closeCandidate: heaviestIdleSession(sessions) };
  }
  if (usedRatio >= bands.caution) {
    return { band: "warn", usedRatio };
  }
  return { band: "ok", usedRatio };
}

/**
 * Thin cgroup adapter (Dev Notes): read the shared user slice's `memory.current` and
 * `memory.max` from the v2 cgroup fs. `memory.max` may be the literal `"max"` (no
 * cap) — surfaced as max=0 so the pure gate treats it as the dangerous unlimited
 * case. Paths are injectable for tests; the default targets the slice of the uid
 * the process runs as. Returns null if the slice files can't be read (the caller
 * decides the fallback).
 */
const SLICE_BASE = userSlicePath();

/**
 * Sum the reclaimable page cache (`inactive_file` + active_file`) out of a cgroup v2
 * `memory.stat` body. These are evictable under pressure, so they don't count toward
 * the working set the gate protects. Unparseable/absent lines contribute 0.
 */
export function reclaimableFromStat(stat: string): number {
  let total = 0;
  for (const line of stat.split("\n")) {
    const [key, val] = line.split(" ");
    if (key === "inactive_file" || key === "active_file") {
      const n = Number(val);
      if (Number.isFinite(n)) total += n;
    }
  }
  return total;
}

export async function readSliceMemory(
  base: string = SLICE_BASE,
): Promise<SliceReading | null> {
  try {
    const [curRaw, maxRaw, statRaw] = await Promise.all([
      readFile(`${base}/memory.current`, "utf8"),
      readFile(`${base}/memory.max`, "utf8"),
      readFile(`${base}/memory.stat`, "utf8").catch(() => ""),
    ]);
    const current = Number(curRaw.trim());
    const maxTrim = maxRaw.trim();
    const max = maxTrim === "max" ? 0 : Number(maxTrim);
    if (!Number.isFinite(current) || !Number.isFinite(max)) return null;
    return { current, max, reclaimable: reclaimableFromStat(statRaw) };
  } catch {
    return null;
  }
}
