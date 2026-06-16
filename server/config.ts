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
  refresh: { fastMs: number; slowMs: number };
  sessions: { historyDays: number; maxHistory: number };
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
  return raw;
}
