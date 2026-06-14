/**
 * The extra reads the alert engine needs, beyond what the dashboard collector
 * already gathers. All world-readable; atrium runs as the invoking user. Called once per
 * fast tick (no second polling loop) alongside the existing collectors.
 *
 * Unit names are pinned to what actually exists on this box (verified): the ssh
 * unit is `ssh` (not `sshd`), there is no postgres, and `atrium` is omitted —
 * a dead atrium can't send its own down-alert. claude-limits health keys off the
 * *timer* + the live memory.max, since the .service is a oneshot that idles.
 */
import { readFile } from "node:fs/promises";

const SLICE = "/sys/fs/cgroup/user.slice/user-1000.slice";

/** Critical units whose disappearance is worth a push. tailscaled/ssh = access risk. */
export const WATCHED_UNITS = ["ssh", "tailscaled", "caddy", "mcp-fs-proxy"];

export interface AlertSources {
  oomKill: number; // cgroup memory.events oom_kill (monotonic)
  ramWall: number; // cgroup memory.events 'max' — allocations refused (monotonic)
  swapPct: number; // slice swap.current / swap.max, 0..100
  swapCurrentKb: number;
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
    systemctlActive([...WATCHED_UNITS, "claude-limits.service", "claude-limits.timer"]),
  ]);

  const swapPct =
    swapCur !== null && swapMax !== null && swapMax > 0
      ? (swapCur / swapMax) * 100
      : 0;

  // "down" = failed or inactive only; treat unknown/activating as up so a
  // systemctl hiccup or a oneshot mid-start never storms.
  const isDown = (s: string | undefined) => s === "failed" || s === "inactive";
  const servicesDown = WATCHED_UNITS.filter((_, i) => isDown(states[i]));

  const svcState = states[WATCHED_UNITS.length];
  const timerState = states[WATCHED_UNITS.length + 1];
  let limitsHealthy = true;
  let limitsReason: string | undefined;
  if (svcState === "failed") {
    limitsHealthy = false;
    limitsReason = "claude-limits.service failed";
  } else if (timerState !== "active") {
    limitsHealthy = false;
    limitsReason = `claude-limits.timer ${timerState ?? "unknown"}`;
  } else if (memMax === null) {
    limitsHealthy = false;
    limitsReason = "slice memory.max reverted to unbounded";
  }

  return {
    oomKill: events.get("oom_kill") ?? 0,
    ramWall: events.get("max") ?? 0,
    swapPct,
    swapCurrentKb: swapCur !== null ? Math.round(swapCur / 1024) : 0,
    psiMemSome: psiMem,
    servicesDown,
    limitsHealthy,
    limitsReason,
  };
}
