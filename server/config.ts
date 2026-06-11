import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RealmConfig {
  name: string;
  path: string;
}

export interface AtriumConfig {
  bind: { host: string; port: number };
  realms: RealmConfig[];
  claudeDir: string;
  refresh: { fastMs: number; slowMs: number };
  sessions: { historyDays: number; maxHistory: number };
  summarize: {
    claudeBin: string;
    model: string;
    scratchDir: string;
    cacheDir: string;
    maxInFlight: number;
    timeoutMs: number;
  };
}

export const repoRoot = resolve(fileURLToPath(import.meta.url), "../..");

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function loadConfig(): AtriumConfig {
  const path =
    process.env.ATRIUM_CONFIG ?? join(repoRoot, "atrium.config.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as AtriumConfig;
  raw.claudeDir = expandHome(raw.claudeDir);
  raw.realms = raw.realms.map((r) => ({ ...r, path: expandHome(r.path) }));
  raw.summarize.scratchDir = expandHome(raw.summarize.scratchDir);
  raw.summarize.cacheDir = expandHome(raw.summarize.cacheDir);
  return raw;
}
