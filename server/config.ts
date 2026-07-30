import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RealmConfig {
  name: string;
  path: string;
}

export interface BifrostConfig {
  bind: { host: string; port: number };
  realms: RealmConfig[];
  claudeDir: string;
  /** Absolute claude binary for interactive spawns (originate/resume/restart).
   *  Omitted → summarize.claudeBin → ~/.local/bin/claude. */
  claudeBin: string;
  refresh: { fastMs: number; slowMs: number };
  sessions: { historyDays: number; maxHistory: number };
  alerts: {
    /** Units whose down-state fires service_down; [] disables the signal. */
    watchedUnits: string[];
    /** Base name of the limits service/timer health pair; null disables. */
    limitsUnit: string | null;
    /** VAPID contact (mailto:/https:) used when generating the keypair. */
    vapidSubject: string;
  };
  lifecycle: {
    /** ARM auto-park kills (SESSION-LIFECYCLE-PLAN §5 Phase 2+). false = Phase 0:
     *  the sweeper only LOGS would-park verdicts to data/park-log.jsonl. */
    enabled: boolean;
    /** Idle window before a session is park-eligible (§9, default 24h). */
    idleParkMs: number;
    /** Max armed kills per sweep (§8 — a watcher bug must not mass-kill). */
    maxKillsPerSweep: number;
  };
  summarize: {
    claudeBin: string;
    model: string;
    effort: string;
    fastStartArgs: string[];
    scratchDir: string;
    cacheDir: string;
    perJobMb: number; // est. memory per summarize job
    ramShare: number; // summaries may use up to this share of total RAM
    memReservePct: number; // hold dispatch if free RAM falls below this share of total
    maxInFlightCap: number; // hard ceiling regardless of box size
    maxQueue: number;
    timeoutMs: number;
  };
  auth: {
    origins: string[]; // allowed Origin header values (exact match) — anti-CSRF
    hosts: string[]; // allowed Host header values — anti DNS-rebinding
    enrollUrl: string; // HTTPS base the enroll CLI/QR points devices to
  };
}

export const repoRoot = resolve(fileURLToPath(import.meta.url), "../..");

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** The current user's systemd slice in the cgroup v2 fs — derived, never
 *  hardcoded, so the memory gate and alert sources work on any uid's box. */
export function userSlicePath(uid: number = process.getuid?.() ?? 1000): string {
  return `/sys/fs/cgroup/user.slice/user-${uid}.slice`;
}

export function loadConfig(): BifrostConfig {
  const path =
    process.env.BIFROST_CONFIG ?? join(repoRoot, "bifrost.config.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as BifrostConfig;
  raw.claudeDir = expandHome(raw.claudeDir);
  raw.realms = raw.realms.map((r) => ({ ...r, path: expandHome(r.path) }));
  raw.summarize.scratchDir = expandHome(raw.summarize.scratchDir);
  raw.summarize.cacheDir = expandHome(raw.summarize.cacheDir);
  // Fail closed: a config without auth → empty allowlists → every /api/* denied.
  raw.auth = raw.auth ?? { origins: [], hosts: [], enrollUrl: "" };
  // The interactive-spawn binary: explicit key → the summarize one (same box,
  // same binary) → the standard install location for whoever runs the service.
  raw.claudeBin = expandHome(
    raw.claudeBin ?? raw.summarize?.claudeBin ?? "~/.local/bin/claude",
  );
  // Alert knobs: neutral defaults — no units watched, no limits pair, and a
  // placeholder VAPID contact — so nothing machine-specific ships in code.
  raw.alerts = {
    watchedUnits: raw.alerts?.watchedUnits ?? [],
    limitsUnit: raw.alerts?.limitsUnit ?? null,
    vapidSubject: raw.alerts?.vapidSubject ?? "mailto:admin@example.com",
  };
  // Idle-park ships DISARMED (observe/log only) — arming is a deliberate
  // config flip after the action log has been reviewed (§5 staged rollout).
  raw.lifecycle = {
    enabled: raw.lifecycle?.enabled ?? false,
    idleParkMs: raw.lifecycle?.idleParkMs ?? 24 * 3_600_000,
    maxKillsPerSweep: raw.lifecycle?.maxKillsPerSweep ?? 2,
  };
  return raw;
}
