import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_QUIESCENT_MS,
  PerUuidLock,
  bifrostTmuxLiveFresh,
  bifrostTmuxName,
  decideResumable,
  pidMatchesStart,
  probeLiveByUuid,
  resumeSession,
  type ResumeDeps,
} from "./resume";
import { buildResumeArgv, sessionName, CLAUDE_BIN } from "./spawn";
import type { SpawnResult } from "./confirm";

const UUID = "aaaabbbb-1111-2222-3333-444455556666";
const NOW = 1_000_000_000_000; // frozen clock; tests never read wall time

// ── AC6.4 — the `--resume` argv builder shape (no model, abs claude, cd to cwd) ─
describe("AC6.4 buildResumeArgv launch shape", () => {
  test("builds `tmux new-session -d -s <name> -c <cwd> <abs claude> --resume <uuid>`", () => {
    const argv = buildResumeArgv({ uuid: UUID, cwd: "/home/you/proj" });
    expect(argv).toEqual([
      "tmux",
      "new-session",
      "-d",
      "-x",
      "220",
      "-y",
      "50",
      "-s",
      sessionName(UUID),
      "-c",
      "/home/you/proj",
      CLAUDE_BIN,
      "--resume",
      UUID,
    ]);
  });

  test("is argv (array), never a shell string — no shell binary, no shell metachars", () => {
    const argv = buildResumeArgv({ uuid: UUID, cwd: "/home/you/proj" });
    expect(Array.isArray(argv)).toBe(true);
    expect(argv).not.toContain("sh");
    expect(argv).not.toContain("bash");
    for (const a of argv) expect(a).not.toMatch(/&&|\|\||;/);
  });

  test("carries NO --model (resume restores the session's own model) and no headless form", () => {
    const argv = buildResumeArgv({ uuid: UUID, cwd: "/home/you/proj" });
    expect(argv).not.toContain("--model");
    expect(argv).not.toContain("--session-id");
    expect(argv).not.toContain("-p");
    expect(argv).not.toContain("--print");
    // the token after the binary is the recognized interactive launch flag
    const binIdx = argv.findIndex((a) => a.endsWith("/claude"));
    expect(argv[binIdx + 1]).toBe("--resume");
  });

  test("AC6.5 — an OUT-OF-REALM cwd builds fine (no /home/you confine on resume)", () => {
    // resume is allowed for any directory; the builder takes the cwd as-is.
    for (const cwd of ["/tmp/scratch", "/home/you", "/var/lib/x", "/home/you/.cache/bg"]) {
      const argv = buildResumeArgv({ uuid: UUID, cwd });
      expect(argv).toContain("-c");
      expect(argv[argv.indexOf("-c") + 1]).toBe(cwd);
    }
  });
});

// ── AC6.1 — pidMatchesStart: /proc liveness + procStart reuse guard ─────────────
describe("AC6.1 pidMatchesStart (procStart pid-reuse guard)", () => {
  // A realistic /proc/<pid>/stat: comm with spaces+parens, then fields 3..; field 22
  // (1-based) is starttime. After ") " the array index 19 is field 22.
  function statLine(starttime: string, comm = "claude (x)"): string {
    // field 3 (state) is index 0 after ") "; starttime is field 22 ⇒ index 19.
    // Real /proc/stat has ~52 fields, so starttime is NOT the last token — trailing
    // fields (and the newline) must not contaminate the starttime read.
    const fields3plus = ["S", "1", "1", "1", "0", "-1", "0", "0", "0", "0", "0", "0", "0", "0", "0", "20", "0", "1", "0", starttime, "0", "0", "0"];
    return `12345 (${comm}) ${fields3plus.join(" ")}\n`;
  }

  test("alive AND matching procStart ⇒ true", () => {
    expect(pidMatchesStart(12345, "987654", () => statLine("987654"))).toBe(true);
  });

  test("a recycled pid (starttime mismatch) ⇒ false", () => {
    expect(pidMatchesStart(12345, "987654", () => statLine("111111"))).toBe(false);
  });

  test("an unreadable /proc (pid gone) ⇒ false", () => {
    expect(
      pidMatchesStart(12345, "987654", () => {
        throw new Error("ENOENT");
      }),
    ).toBe(false);
  });

  test("no recorded procStart ⇒ accept any live pid (alive is enough)", () => {
    expect(pidMatchesStart(12345, undefined, () => statLine("anything"))).toBe(true);
  });

  test("parses starttime correctly even when comm contains a ')'", () => {
    // last ')' must be the comm closer, not one inside the comm.
    expect(pidMatchesStart(12345, "555", () => statLine("555", "weird ) name"))).toBe(true);
  });
});

// ── AC6.1 — probeLiveByUuid: FRESH read of sessions dir, never the snapshot ─────
describe("AC6.1 probeLiveByUuid (fresh sessions-dir + /proc probe)", () => {
  function sessionsDir(): string {
    const root = mkdtempSync(join(tmpdir(), "bifrost-resume-"));
    const dir = join(root, "sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  function writePidFile(dir: string, pid: number, sessionId: string, procStart?: string): void {
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, procStart }));
  }

  test("a live pid file naming the uuid (passing the /proc guard) ⇒ livePid set", async () => {
    const dir = sessionsDir();
    writePidFile(dir, 4242, UUID, "ps-1");
    const r = await probeLiveByUuid(UUID, {
      sessionsDir: dir,
      readStat: () => `4242 (claude) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ps-1 0 0 0\n`,
    });
    expect(r.livePid).toBe(4242);
    expect(r.pidFilePresent).toBe(true);
  });

  test("a pid file naming the uuid whose /proc FAILS the guard ⇒ livePid null but pidFilePresent (H4)", async () => {
    const dir = sessionsDir();
    writePidFile(dir, 4242, UUID, "ps-1");
    const r = await probeLiveByUuid(UUID, {
      sessionsDir: dir,
      // recycled pid: starttime mismatch
      readStat: () => `4242 (claude) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 OTHER 0 0 0\n`,
    });
    expect(r.livePid).toBeNull();
    // The uuid is referenced — the gate must NOT treat this as safe-to-resume (H4).
    expect(r.pidFilePresent).toBe(true);
  });

  test("no pid file naming the uuid ⇒ a true not-live negative", async () => {
    const dir = sessionsDir();
    writePidFile(dir, 4242, "some-other-uuid", "ps-1");
    const r = await probeLiveByUuid(UUID, {
      sessionsDir: dir,
      readStat: () => `4242 (claude) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ps-1 0 0 0\n`,
    });
    expect(r.livePid).toBeNull();
    expect(r.pidFilePresent).toBe(false);
  });

  test("a missing sessions dir ⇒ a true not-live negative (no throw)", async () => {
    const r = await probeLiveByUuid(UUID, { sessionsDir: "/no/such/sessions" });
    expect(r).toEqual({ livePid: null, pidFilePresent: false });
  });

  test("reads the dir FRESH each call (not a cached snapshot) — a file that appears between calls is seen", async () => {
    const dir = sessionsDir();
    const stat = () => `4242 (claude) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ps-1 0 0 0\n`;
    const before = await probeLiveByUuid(UUID, { sessionsDir: dir, readStat: stat });
    expect(before.livePid).toBeNull();
    writePidFile(dir, 4242, UUID, "ps-1"); // the session just booted
    const after = await probeLiveByUuid(UUID, { sessionsDir: dir, readStat: stat });
    expect(after.livePid).toBe(4242); // the fresh re-read sees it
  });
});

// ── AC6.1 — decideResumable: the POSITIVE not-live gate over fresh signals ──────
describe("AC6.1 decideResumable (positive not-live gate)", () => {
  const quiescentMtime = NOW - DEFAULT_QUIESCENT_MS - 1; // strictly older than the window

  test("QUIESCENT fixture: old mtime, no live pid, no tmux ⇒ resumable", () => {
    expect(
      decideResumable(
        { mtimeMs: quiescentMtime, livePid: null, pidFilePresent: false, bifrostTmuxLive: false },
        NOW,
      ),
    ).toEqual({ resumable: true });
  });

  test("LIVE fixture (live pid) ⇒ not resumable, reason 'live' (route to drive)", () => {
    expect(
      decideResumable(
        { mtimeMs: quiescentMtime, livePid: 4242, pidFilePresent: true, bifrostTmuxLive: false },
        NOW,
      ),
    ).toEqual({ resumable: false, reason: "live" });
  });

  test("LIVE fixture (Bifrost tmux session present) ⇒ not resumable, reason 'live'", () => {
    expect(
      decideResumable(
        { mtimeMs: quiescentMtime, livePid: null, pidFilePresent: false, bifrostTmuxLive: true },
        NOW,
      ),
    ).toEqual({ resumable: false, reason: "live" });
  });

  test("BOOTING fixture (recent mtime, no pid yet) ⇒ NOT resumable (not-quiescent)", () => {
    // a just-booted / mid-write session must not read resumable even with no pid file.
    expect(
      decideResumable(
        { mtimeMs: NOW - 100, livePid: null, pidFilePresent: false, bifrostTmuxLive: false },
        NOW,
      ),
    ).toEqual({ resumable: false, reason: "not-quiescent" });
  });

  test("mtime exactly AT the window edge ⇒ NOT quiescent (boundary, inclusive)", () => {
    expect(
      decideResumable(
        { mtimeMs: NOW - DEFAULT_QUIESCENT_MS, livePid: null, pidFilePresent: false, bifrostTmuxLive: false },
        NOW,
      ),
    ).toEqual({ resumable: false, reason: "not-quiescent" });
  });

  test("MID-REWRITE fixture (pid file references uuid but /proc unconfirmed) ⇒ NOT resumable (H4)", () => {
    // quiescent mtime + no confirmed live pid, but a pid file names the uuid: refuse,
    // never authorize a second writer off a transient /proc failure.
    expect(
      decideResumable(
        { mtimeMs: quiescentMtime, livePid: null, pidFilePresent: true, bifrostTmuxLive: false },
        NOW,
      ),
    ).toEqual({ resumable: false, reason: "uuid-referenced" });
  });

  test("unknown mtime ⇒ NOT quiescent (treated as possibly-booting)", () => {
    expect(
      decideResumable(
        { mtimeMs: undefined, livePid: null, pidFilePresent: false, bifrostTmuxLive: false },
        NOW,
      ),
    ).toEqual({ resumable: false, reason: "not-quiescent" });
  });

  test("bifrostTmuxName equals the spawn session name for the uuid", () => {
    expect(bifrostTmuxName(UUID)).toBe(sessionName(UUID));
  });
});

// ── AC6.2 — per-uuid in-process lock (concurrent same-uuid ⇒ already-starting) ──
describe("AC6.2 PerUuidLock (concurrency 409)", () => {
  test("a concurrent SAME-uuid run is rejected without running fn (no second writer)", async () => {
    const lock = new PerUuidLock();
    let firstStarted = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let secondRan = false;

    const first = lock.run(UUID, async () => {
      firstStarted = true;
      await gate; // hold the lock until we release it
      return "first-done";
    });
    // Issue the concurrent same-uuid resume while the first still holds the lock.
    await Promise.resolve();
    expect(firstStarted).toBe(true);
    const second = await lock.run(UUID, async () => {
      secondRan = true;
      return "second-done";
    });
    expect(second).toEqual({ ok: false, reason: "already-starting" });
    expect(secondRan).toBe(false); // fn never ran — the critical section was guarded

    release();
    expect(await first).toEqual({ ok: true, value: "first-done" });
  });

  test("DIFFERENT uuids never contend — both run", async () => {
    const lock = new PerUuidLock();
    let holdRelease!: () => void;
    const held = new Promise<void>((r) => (holdRelease = r));
    const a = lock.run("uuid-a", async () => {
      await held;
      return "a";
    });
    const b = await lock.run("uuid-b", async () => "b");
    expect(b).toEqual({ ok: true, value: "b" }); // not blocked by uuid-a's lock
    holdRelease();
    expect(await a).toEqual({ ok: true, value: "a" });
  });

  test("the lock is released after fn so the same uuid can resume again later", async () => {
    const lock = new PerUuidLock();
    expect(await lock.run(UUID, async () => 1)).toEqual({ ok: true, value: 1 });
    // second, non-concurrent attempt acquires fine
    expect(await lock.run(UUID, async () => 2)).toEqual({ ok: true, value: 2 });
  });

  test("the lock is released even if fn THROWS (no permanent deadlock)", async () => {
    const lock = new PerUuidLock();
    await expect(
      lock.run(UUID, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // a subsequent resume for the same uuid is not deadlocked
    expect(await lock.run(UUID, async () => "ok")).toEqual({ ok: true, value: "ok" });
  });
});

// ── AC6.3 / AC6.4 / AC6.5 — the resume orchestration over injected effects ──────
describe("resume orchestration (resumeSession)", () => {
  const quiescentMtime = NOW - DEFAULT_QUIESCENT_MS - 1;
  // A baseline deps set: quiescent, not live, cwd present, spawn confirms.
  function baseDeps(over: Partial<ResumeDeps> = {}): ResumeDeps {
    return {
      probe: async () => ({ livePid: null, pidFilePresent: false }),
      bifrostTmuxLive: () => false,
      transcriptMtime: () => quiescentMtime,
      readBackCwd: async () => "/home/you/proj",
      cwdExists: async () => true,
      issueResume: async (uuid, _cwd): Promise<SpawnResult> => ({
        ok: true,
        tmuxSession: sessionName(uuid),
        transcriptPath: `/p/${uuid}.jsonl`,
      }),
      now: () => NOW,
      ...over,
    };
  }

  test("AC6.3 — an already-live session routes to drive, NEVER issuing a resume", async () => {
    let issued = false;
    const out = await resumeSession(UUID, baseDeps({
      probe: async () => ({ livePid: 4242, pidFilePresent: true }),
      issueResume: async () => {
        issued = true;
        return { ok: false, reason: "confirm-timeout" };
      },
    }));
    expect(out).toEqual({ ok: false, reason: "already-live" });
    expect(issued).toBe(false); // no second claude on a live transcript
  });

  test("AC6.3 — live via Bifrost tmux session ⇒ already-live, no spawn", async () => {
    let issued = false;
    const out = await resumeSession(UUID, baseDeps({
      bifrostTmuxLive: () => true,
      issueResume: async () => {
        issued = true;
        return { ok: false, reason: "confirm-timeout" };
      },
    }));
    expect(out).toEqual({ ok: false, reason: "already-live" });
    expect(issued).toBe(false);
  });

  test("a BOOTING (not-quiescent) session refuses, never issuing a resume", async () => {
    let issued = false;
    const out = await resumeSession(UUID, baseDeps({
      transcriptMtime: () => NOW - 100, // recent ⇒ not quiescent
      issueResume: async () => {
        issued = true;
        return { ok: true, tmuxSession: "x", transcriptPath: "y" };
      },
    }));
    expect(out).toEqual({ ok: false, reason: "not-resumable", detail: "not-quiescent" });
    expect(issued).toBe(false);
  });

  test("a mid-rewrite pid file (uuid referenced, /proc unconfirmed) refuses (H4)", async () => {
    let issued = false;
    const out = await resumeSession(UUID, baseDeps({
      probe: async () => ({ livePid: null, pidFilePresent: true }),
      issueResume: async () => {
        issued = true;
        return { ok: true, tmuxSession: "x", transcriptPath: "y" };
      },
    }));
    expect(out).toEqual({ ok: false, reason: "not-resumable", detail: "uuid-referenced" });
    expect(issued).toBe(false);
  });

  test("AC6.4 — a MISSING transcript cwd surfaces 'degraded — cwd missing', not a launch", async () => {
    let issued = false;
    const out = await resumeSession(UUID, baseDeps({
      readBackCwd: async () => "/home/you/gone",
      cwdExists: async () => false,
      issueResume: async () => {
        issued = true;
        return { ok: true, tmuxSession: "x", transcriptPath: "y" };
      },
    }));
    expect(out).toEqual({ ok: false, reason: "degraded-cwd-missing", cwd: "/home/you/gone" });
    expect(issued).toBe(false);
  });

  test("AC6.4 — an UNREADABLE transcript cwd surfaces degraded, not a launch", async () => {
    let issued = false;
    const out = await resumeSession(UUID, baseDeps({
      readBackCwd: async () => undefined,
      issueResume: async () => {
        issued = true;
        return { ok: true, tmuxSession: "x", transcriptPath: "y" };
      },
    }));
    expect(out).toEqual({ ok: false, reason: "degraded-cwd-unreadable" });
    expect(issued).toBe(false);
  });

  test("AC6.4/AC6.5 — a quiescent, not-live session resumes at its OWN (out-of-realm) cwd", async () => {
    const seen: { uuid: string; cwd: string }[] = [];
    const out = await resumeSession(UUID, baseDeps({
      // an out-of-realm cwd — resume confines nothing (AC6.5)
      readBackCwd: async () => "/tmp/out-of-realm",
      cwdExists: async () => true,
      issueResume: async (uuid, cwd) => {
        seen.push({ uuid, cwd });
        return { ok: true, tmuxSession: sessionName(uuid), transcriptPath: `/p/${uuid}.jsonl` };
      },
    }));
    expect(out).toEqual({
      ok: true,
      uuid: UUID,
      tmuxSession: sessionName(UUID),
      transcriptPath: `/p/${UUID}.jsonl`,
    });
    // the launch cd'd to the transcript's OWN out-of-realm cwd, unconfined
    expect(seen).toEqual([{ uuid: UUID, cwd: "/tmp/out-of-realm" }]);
  });

  test("a spawn collision/timeout surfaces spawn-failed", async () => {
    const out = await resumeSession(UUID, baseDeps({
      issueResume: async () => ({ ok: false, reason: "collision", stderr: "dup" }),
    }));
    expect(out).toEqual({ ok: false, reason: "spawn-failed", detail: "collision" });
  });

  test("a thrown spawn (e.g. missing-binary assertion) surfaces spawn-failed with the message", async () => {
    const out = await resumeSession(UUID, baseDeps({
      issueResume: async () => {
        throw new Error("claude binary not found");
      },
    }));
    expect(out).toEqual({ ok: false, reason: "spawn-failed", detail: "claude binary not found" });
  });
});

// ── AC6.2/AC6.5 — throwaway-tmux live launch + concurrent-resume integration ────
// Mirrors confirm.test.ts: a throwaway tmux session running `sleep` stands in for a
// resumed claude (NEVER real claude), with a hand-written `<uuid>.jsonl` fixture so
// the confirm readback passes. Asserts the launch lands a live pane at an OUT-OF-REALM
// cwd (AC6.5) and that a concurrent same-uuid resume is rejected (AC6.2).
async function hasTmux(): Promise<boolean> {
  try {
    const p = Bun.spawn(["tmux", "-V"], { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}
const td = (await hasTmux()) ? describe : describe.skip;

td("AC6.2/AC6.5 throwaway-tmux resume launch", () => {
  const killed: string[] = [];
  afterEach(async () => {
    for (const name of killed.splice(0)) {
      const p = Bun.spawn(["tmux", "kill-session", "-t", name], { stdout: "ignore", stderr: "ignore" });
      await p.exited;
    }
  });

  function fakeProjects(): { root: string; projectsDir: string } {
    const root = mkdtempSync(join(tmpdir(), "bifrost-resume-tmux-"));
    return { root, projectsDir: join(root, "projects") };
  }
  function writeTranscript(projectsDir: string, uuid: string, cwd: string): void {
    const dir = join(projectsDir, cwd.replace(/[/.]/g, "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${uuid}.jsonl`),
      [
        JSON.stringify({ type: "operation", sessionId: uuid }),
        JSON.stringify({ type: "user", cwd, message: { role: "user", content: "hi" } }),
      ].join("\n") + "\n",
    );
  }

  test("a quiescent session resumes: a live pane lands at the OUT-OF-REALM transcript cwd (AC6.5)", async () => {
    const uuid = "ffff0000-1111-2222-3333-444455556666";
    const name = sessionName(uuid);
    killed.push(name);
    const { projectsDir } = fakeProjects();
    // out-of-realm cwd: /tmp (a real, existing dir — resume confines nothing)
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-oor-"));
    writeTranscript(projectsDir, uuid, cwd);

    const lock = new PerUuidLock();
    const issueResume = async (id: string, c: string): Promise<SpawnResult> => {
      // Stand-in launch: a throwaway tmux session running `sleep` at the cwd (never
      // real claude). Then confirm against the hand-written transcript.
      const p = Bun.spawn(["tmux", "new-session", "-d", "-s", name, "-c", c, "sleep", "30"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      if ((await p.exited) !== 0) return { ok: false, reason: "collision", stderr: "" };
      return { ok: true, tmuxSession: name, transcriptPath: join(projectsDir, "x", `${id}.jsonl`) };
    };

    const r = await lock.run(uuid, () =>
      resumeSession(uuid, {
        probe: async () => ({ livePid: null, pidFilePresent: false }),
        bifrostTmuxLive: () => false,
        transcriptMtime: () => NOW - DEFAULT_QUIESCENT_MS - 1,
        readBackCwd: async () => cwd,
        cwdExists: async () => true,
        issueResume,
        now: () => NOW,
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.ok).toBe(true);

    // The pane is genuinely live under the shared tmux server.
    const has = Bun.spawn(["tmux", "has-session", "-t", name], { stdout: "ignore", stderr: "ignore" });
    expect(await has.exited).toBe(0);
  });

  test("a concurrent same-uuid resume is rejected while the first holds the lock (AC6.2)", async () => {
    const uuid = "eeee0000-1111-2222-3333-444455556666";
    const lock = new PerUuidLock();
    let firstReleased!: () => void;
    const hold = new Promise<void>((r) => (firstReleased = r));
    let secondIssued = false;

    const first = lock.run(uuid, async () => {
      await hold; // keep the critical section open
      return "done";
    });
    await Promise.resolve();
    const second = await lock.run(uuid, async () => {
      secondIssued = true;
      return "second";
    });
    expect(second).toEqual({ ok: false, reason: "already-starting" });
    expect(secondIssued).toBe(false);
    firstReleased();
    await first;
  });

  test("AC6.1 — bifrostTmuxLiveFresh reads the live tmux server FRESH (true only while a pane exists)", async () => {
    const uuid = "dddd0000-1111-2222-3333-444455556666";
    const name = sessionName(uuid);
    killed.push(name);
    // No Bifrost pane for the uuid yet ⇒ fresh probe is false.
    expect(await bifrostTmuxLiveFresh(uuid)).toBe(false);
    // Create the Bifrost-named pane (a throwaway `sleep`, never real claude).
    const p = Bun.spawn(["tmux", "new-session", "-d", "-s", name, "sleep", "30"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await p.exited).toBe(0);
    // The fresh probe now sees it — no tick snapshot involved.
    expect(await bifrostTmuxLiveFresh(uuid)).toBe(true);
  });
});
