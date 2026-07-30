/**
 * Story 2-2 / AC2.2 server contract: `sessionIndexEntries()` exposes the FULL
 * *uncapped* session index for the client name search — not the maxHistory-capped
 * snapshot. With more dead transcripts than `maxHistory`, every one appears in the
 * index (so a search can find a session the dashboard list dropped), and the
 * `live` flag is taken from the passed live set (a live row routes to the drive
 * view, a dead one to a view-only open).
 *
 * Same fixture/restart harness as sessionIndex.integration.test.ts: a fresh
 * cache-busted module per boot, a frozen clock, an isolated data dir.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSystemTime } from "bun:test";
import type { BifrostConfig } from "../config";
import type { SessionIndexEntry } from "../../shared/types";

const T0 = 1_700_000_000_000;

let root: string;
let claudeDir: string;
let modSeq = 0;

const cfg = (): BifrostConfig =>
  ({
    bind: { host: "127.0.0.1", port: 0 },
    realms: [],
    claudeDir,
    claudeBin: "/opt/claude",
    alerts: { watchedUnits: [], limitsUnit: null, vapidSubject: "mailto:admin@example.com" },
    lifecycle: { enabled: false, idleParkMs: 86_400_000, maxKillsPerSweep: 2 },
    refresh: { fastMs: 3000, slowMs: 30000 },
    // maxHistory deliberately smaller than the number of dead transcripts below,
    // so the capped snapshot ≠ the uncapped index.
    sessions: { historyDays: 14, maxHistory: 2 },
    summarize: {
      claudeBin: "/bin/true",
      model: "sonnet",
      effort: "low",
      fastStartArgs: [],
      scratchDir: "/nonexistent/scratch",
      cacheDir: "/nonexistent/cache",
      perJobMb: 1,
      ramShare: 0.1,
      memReservePct: 0.1,
      maxInFlightCap: 1,
      maxQueue: 1,
      timeoutMs: 1000,
    },
    auth: { origins: [], hosts: [], enrollUrl: "" },
  }) as BifrostConfig;

function transcript(cwd: string, customTitle?: string): string {
  const lines: string[] = [];
  if (customTitle) lines.push(JSON.stringify({ type: "custom-title", customTitle }));
  lines.push(
    JSON.stringify({
      type: "user",
      cwd,
      timestamp: "2026-06-11T10:00:00.000Z",
      message: { role: "user", content: "do the thing" },
    }),
  );
  return lines.join("\n") + "\n";
}

async function writeTranscript(
  slug: string,
  uuid: string,
  cwd: string,
  mtimeMs: number,
  customTitle?: string,
): Promise<void> {
  const dir = join(claudeDir, "projects", slug);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${uuid}.jsonl`);
  await writeFile(path, transcript(cwd, customTitle));
  const sec = mtimeMs / 1000;
  await utimes(path, sec, sec);
}

async function freshCollector() {
  return import(`./sessions.ts?ie=${modSeq++}`);
}

beforeEach(async () => {
  setSystemTime(new Date(T0));
  root = await mkdtemp(join(tmpdir(), "bifrost-ie-"));
  claudeDir = join(root, ".claude");
  await mkdir(join(claudeDir, "projects"), { recursive: true });
  await mkdir(join(claudeDir, "sessions"), { recursive: true }); // no live pids
  await rm(join(process.env.BIFROST_DATA_DIR!, "session-index.json"), { force: true });
});

afterEach(async () => {
  setSystemTime();
  await rm(root, { recursive: true, force: true });
  await rm(join(process.env.BIFROST_DATA_DIR!, "session-index.json"), { force: true });
});

describe("sessionIndexEntries (AC2.2) — full uncapped index", () => {
  test("returns every indexed transcript, not just maxHistory rows", async () => {
    // 4 dead transcripts; maxHistory=2. The capped snapshot drops 2 of them, but
    // the uncapped index must still carry all 4 (so search can find them).
    await writeTranscript("-home-you-projects-a", "uuid-a", "/home/you/projects/a", T0 - 1000);
    await writeTranscript("-home-you-projects-b", "uuid-b", "/home/you/projects/b", T0 - 2000);
    await writeTranscript("-home-you-projects-c", "uuid-c", "/home/you/projects/c", T0 - 3000);
    await writeTranscript("-home-you-projects-d", "uuid-d", "/home/you/projects/d", T0 - 4000, "Renamed D");

    const mod = await freshCollector();
    const res = await mod.collectSessions(cfg());
    // The snapshot is capped (≤ maxHistory dead interactive rows).
    expect(res.sessions.length).toBeLessThanOrEqual(2);

    // The index is uncapped — all 4 transcripts present.
    const entries: SessionIndexEntry[] = mod.sessionIndexEntries(new Set<string>());
    const ids = new Set(entries.map((e) => e.sessionId));
    expect(ids).toEqual(new Set(["uuid-a", "uuid-b", "uuid-c", "uuid-d"]));
    expect(entries.length).toBeGreaterThan(res.sessions.length);
  });

  test("carries the searchable name (customTitle when renamed, else basename(cwd))", async () => {
    await writeTranscript("-home-you-projects-atlas-web", "plain", "/home/you/projects/atlas-web", T0 - 1000);
    await writeTranscript("-home-you-projects-ledger-api", "named", "/home/you/projects/ledger-api", T0 - 2000, "LEDGER Build");
    const mod = await freshCollector();
    await mod.collectSessions(cfg());
    const entries: SessionIndexEntry[] = mod.sessionIndexEntries(new Set<string>());
    const byId = new Map(entries.map((e) => [e.sessionId, e]));
    expect(byId.get("named")?.customTitle).toBe("LEDGER Build");
    expect(byId.get("plain")?.customTitle).toBe("atlas-web"); // basename(cwd)
    expect(byId.get("plain")?.cwd).toBe("/home/you/projects/atlas-web");
  });

  test("the live flag comes from the passed live set", async () => {
    await writeTranscript("-home-you-projects-a", "uuid-a", "/home/you/projects/a", T0 - 1000);
    await writeTranscript("-home-you-projects-b", "uuid-b", "/home/you/projects/b", T0 - 2000);
    const mod = await freshCollector();
    await mod.collectSessions(cfg());
    const entries: SessionIndexEntry[] = mod.sessionIndexEntries(new Set(["uuid-a"]));
    const byId = new Map(entries.map((e) => [e.sessionId, e]));
    expect(byId.get("uuid-a")?.live).toBe(true);
    expect(byId.get("uuid-b")?.live).toBe(false);
  });
});
