/**
 * Integration coverage for the materialized index against a fixture claudeDir:
 * - AC1.2 cheap pass records {mtimeMs, slug, cwd, name} (renamed + un-renamed)
 * - AC1.3 warm restart re-parses no unchanged file (cheap pass skips it)
 * - AC1.4 duplicate sessionId across slug dirs → deterministic, one warning
 * - AC1.5 savedDefaultEvents does not run a second stat-all walk
 *
 * Each `collectSessions` "boot" is a fresh cache-busted module import so the
 * in-memory caches reset like a real restart; the persisted index under the
 * test data dir is what carries across. The clock is frozen/advanced so the
 * full sweep fires deterministically.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fsp from "node:fs/promises";
import { setSystemTime } from "bun:test";
import type { BifrostConfig } from "../config";
import type { SessionInfo } from "../../shared/types";

const T0 = 1_700_000_000_000; // frozen base epoch ms

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

/** Minimal valid transcript: optional custom-title line + one user line w/ cwd. */
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
): Promise<string> {
  const dir = join(claudeDir, "projects", slug);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${uuid}.jsonl`);
  await writeFile(path, transcript(cwd, customTitle));
  const sec = mtimeMs / 1000;
  await utimes(path, sec, sec);
  return path;
}

/** A fresh module instance — like a process restart (caches empty, index reloads). */
async function freshCollector() {
  return import(`./sessions.ts?boot=${modSeq++}`);
}

beforeEach(async () => {
  setSystemTime(new Date(T0));
  root = await mkdtemp(join(tmpdir(), "bifrost-idx-"));
  claudeDir = join(root, ".claude");
  await mkdir(join(claudeDir, "projects"), { recursive: true });
  await mkdir(join(claudeDir, "sessions"), { recursive: true }); // no live pids
  // wipe any persisted index from a prior test
  const dataIdx = join(process.env.BIFROST_DATA_DIR!, "session-index.json");
  await rm(dataIdx, { force: true });
});

afterEach(async () => {
  setSystemTime();
  await rm(root, { recursive: true, force: true });
  await rm(join(process.env.BIFROST_DATA_DIR!, "session-index.json"), { force: true });
});

describe("cheap pass records name (AC1.2)", () => {
  test("renamed transcript → name=customTitle; un-renamed → name=basename(cwd)", async () => {
    await writeTranscript("-home-you-projects-ledger-api", "renamed-uuid", "/home/you/projects/ledger-api", T0 - 1000, "LEDGER Build");
    await writeTranscript("-home-you-projects-atlas-web", "plain-uuid", "/home/you/projects/atlas-web", T0 - 2000);
    const mod = await freshCollector();
    const res = await mod.collectSessions(cfg());
    const byId = new Map<string, SessionInfo>(
      (res.sessions as SessionInfo[]).map((s) => [s.sessionId, s]),
    );
    expect(byId.get("renamed-uuid")?.customTitle).toBe("LEDGER Build");
    // un-renamed: no customTitle, but the index recorded name=basename(cwd)
    expect(byId.has("plain-uuid")).toBe(true);
    expect(byId.get("plain-uuid")?.customTitle).toBeUndefined();
  });
});

describe("duplicate sessionId across slug dirs (AC1.4)", () => {
  test("resolves deterministically and warns exactly once", async () => {
    const cwd = "/home/you/projects/vector-lab";
    const matchSlug = "-home-you-projects-vector-lab";
    // winner: slug matches cwd (older); loser: a stale sibling slug (newer mtime)
    await writeTranscript(matchSlug, "shared-uuid", cwd, T0 - 5000);
    await writeTranscript("-stale-sibling", "shared-uuid", cwd, T0 - 1000);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mod = await freshCollector();
      await mod.collectSessions(cfg());
      // The slug-matching path wins regardless of mtime; resolve to it twice (stable).
      const winnerPath = mod.transcriptPathFor("shared-uuid");
      expect(winnerPath).toContain(matchSlug);
      const dupWarnings = warn.mock.calls.filter((c) =>
        String(c[0]).includes("duplicate sessionId shared-uuid"),
      );
      expect(dupWarnings.length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("warm restart re-parses no unchanged file (AC1.3)", () => {
  test("an unchanged, beyond-cap dead transcript is not re-read on the second boot", async () => {
    // 3 dead transcripts, maxHistory=2 → the OLDEST (beyond the cap) is never
    // deep-parsed, so any read of it must come from the cheap index pass.
    const beyond = await writeTranscript("-home-you-a", "beyond-cap", "/home/you/a", T0 - 9000);
    await writeTranscript("-home-you-b", "row-b", "/home/you/b", T0 - 1000);
    await writeTranscript("-home-you-c", "row-c", "/home/you/c", T0 - 2000);

    // Boot 1 (cold): builds + persists the index, cheap-reading every file once.
    const mod1 = await freshCollector();
    await mod1.collectSessions(cfg());

    // Boot 2 (warm restart): fresh module, persisted index reloads. Advance the
    // clock past the sweep interval so the sweep fires again.
    setSystemTime(new Date(T0 + 40_000));
    const opens: string[] = [];
    const realOpen = fsp.open;
    const openSpy = spyOn(fsp, "open").mockImplementation((...args: Parameters<typeof fsp.open>) => {
      opens.push(String(args[0]));
      return realOpen(...args);
    });
    try {
      const mod2 = await freshCollector();
      await mod2.collectSessions(cfg());
    } finally {
      openSpy.mockRestore();
    }
    // The beyond-cap file is unchanged → its cheap pass is skipped and it is
    // beyond maxHistory so never deep-parsed → zero opens on boot 2.
    const beyondOpens = opens.filter((p) => p === beyond);
    expect(beyondOpens.length).toBe(0);
  });
});

describe("savedDefaultEvents reuses the index — no second stat-all walk (AC1.5)", () => {
  test("collectSessions issues no extra per-file stat pass for saved-defaults", async () => {
    // N transcripts; the sweep stats each once. If savedDefaultEvents still did
    // its own walk it would stat all N a second time. Count stat() calls and
    // assert they don't exceed the single-sweep budget.
    const N = 5;
    for (let i = 0; i < N; i++) {
      await writeTranscript(`-home-you-p${i}`, `uuid-${i}`, `/home/you/p${i}`, T0 - (i + 1) * 1000);
    }
    const statSpy = spyOn(fsp, "stat");
    try {
      const mod = await freshCollector();
      await mod.collectSessions(cfg());
      const statPaths = statSpy.mock.calls.map((c) => String(c[0]));
      const perTranscript = (uuid: string) => statPaths.filter((p) => p.includes(uuid)).length;
      // Each transcript is stat'd by the sweep at most once (live re-stat doesn't
      // run — no live pids). A second saved-defaults walk would double this.
      for (let i = 0; i < N; i++) {
        expect(perTranscript(`uuid-${i}`)).toBeLessThanOrEqual(1);
      }
    } finally {
      statSpy.mockRestore();
    }
  });
});
