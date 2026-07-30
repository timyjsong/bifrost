/**
 * The extra reads the alert engine needs, beyond what the dashboard collector
 * already gathers. Every source is world-readable, so this runs with no more
 * privilege than the dashboard. Called once per fast tick (no second polling
 * loop) alongside the existing collectors.
 *
 * Which units get watched is configuration, not code: `alerts.watchedUnits` and
 * `alerts.limitsUnit` arrive from bifrost.config.json at boot, and both default
 * to empty — an unconfigured install watches nothing rather than alerting on
 * services it invented. Two notes worth carrying:
 *   - Don't list bifrost's own unit. A dead bifrost cannot send its own
 *     down-alert, so watching itself buys a silent failure.
 *   - `limitsUnit` health keys off the *timer* plus the live memory.max, because
 *     a rearm unit of this shape is typically a oneshot that idles between runs
 *     — an inactive .service is normal and would otherwise read as down.
 */
import { readFile } from "node:fs/promises";
import { userSlicePath } from "../config";

const SLICE = userSlicePath();

/** Units whose down-state fires service_down + the limits health pair — set
 *  from cfg.alerts at boot. Neutral until configured: nothing watched. */
let watchedUnits: string[] = [];
let limitsUnit: string | null = null;

export function configureAlertSources(opts: {
  watchedUnits: string[];
  limitsUnit: string | null;
}): void {
  watchedUnits = opts.watchedUnits;
  limitsUnit = opts.limitsUnit;
}

export interface AlertSources {
  oomKill: number; // cgroup memory.events oom_kill (monotonic)
  ramWall: number; // cgroup memory.events 'max' — allocations refused (monotonic)
  swapPct: number; // slice swap.current / swap.max, 0..100
  swapCurrentKb: number;
  sliceMaxKb: number | null; // slice memory.max cap; null = unbounded
  psiMemSome: number; // /proc/pressure/memory  some avg10
  servicesDown: string[]; // watched units currently failed/inactive
  limitsHealthy: boolean; // the safeguard itself
  limitsReason?: string;
}

async function readKv(path: string): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  try {
    for (const line of (await readFile(path, "utf8")).split("\n")) {
      const [k, v] = line.trim().split(/\s+/);
      if (k && v !== undefined) m.set(k, Number(v));
    }
  } catch {
    /* cgroup absent — leave empty */
  }
  return m;
}

/** A cgroup numeric leaf; `null` when the file reads "max" (unbounded) or is absent. */
async function readNum(path: string): Promise<number | null> {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    if (raw === "max") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function psiSome(path: string): Promise<number> {
  try {
    const m = (await readFile(path, "utf8")).match(/some\s+avg10=([\d.]+)/);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

async function systemctlActive(units: string[]): Promise<string[]> {
  try {
    const proc = Bun.spawn(["systemctl", "is-active", ...units], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim().split("\n").map((s) => s.trim());
  } catch {
    return units.map(() => "unknown");
  }
}

export async function collectAlertSources(): Promise<AlertSources> {
  const [events, swapCur, swapMax, memMax, psiMem, states] = await Promise.all([
    readKv(`${SLICE}/memory.events`),
    readNum(`${SLICE}/memory.swap.current`),
    readNum(`${SLICE}/memory.swap.max`),
    readNum(`${SLICE}/memory.max`),
    psiSome("/proc/pressure/memory"),
    systemctlActive(
      limitsUnit
        ? [...watchedUnits, `${limitsUnit}.service`, `${limitsUnit}.timer`]
        : [...watchedUnits],
    ),
  ]);

  const swapPct =
    swapCur !== null && swapMax !== null && swapMax > 0
      ? (swapCur / swapMax) * 100
      : 0;

  // "down" = failed or inactive only; treat unknown/activating as up so a
  // systemctl hiccup or a oneshot mid-start never storms.
  const isDown = (s: string | undefined) => s === "failed" || s === "inactive";
  const servicesDown = watchedUnits.filter((_, i) => isDown(states[i]));

  // The limits pair is optional (box-specific tooling): unconfigured → healthy.
  let limitsHealthy = true;
  let limitsReason: string | undefined;
  if (limitsUnit) {
    const svcState = states[watchedUnits.length];
    const timerState = states[watchedUnits.length + 1];
    if (svcState === "failed") {
      limitsHealthy = false;
      limitsReason = `${limitsUnit}.service failed`;
    } else if (timerState !== "active") {
      limitsHealthy = false;
      limitsReason = `${limitsUnit}.timer ${timerState ?? "unknown"}`;
    } else if (memMax === null) {
      limitsHealthy = false;
      limitsReason = "slice memory.max reverted to unbounded";
    }
  }

  return {
    oomKill: events.get("oom_kill") ?? 0,
    ramWall: events.get("max") ?? 0,
    swapPct,
    swapCurrentKb: swapCur !== null ? Math.round(swapCur / 1024) : 0,
    sliceMaxKb: memMax !== null ? Math.round(memMax / 1024) : null,
    psiMemSome: psiMem,
    servicesDown,
    limitsHealthy,
    limitsReason,
  };
}
