import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_RESTART_MODE,
  confirmKilled,
  decideRestart,
  procAliveFor,
  restartSession,
  type KillDeps,
  type RestartDeps,
} from "./restart";
import { sessionName } from "./spawn";
import type { SpawnResult } from "./confirm";

const UUID = "aaaabbbb-1111-2222-3333-444455556666";
const NOW = 1_000_000_000_000; // frozen clock; tests never read wall time

// ── AC7.1 — confirm-before-kill gate (both modes require an explicit confirm) ────
describe("AC7.1 decideRestart (confirm-before-kill gate)", () => {
  test("confirm:true with no mode ⇒ proceed in the DEFAULT (resume) mode", () => {
    expect(decideRestart({ confirm: true })).toEqual({ proceed: true, mode: "resume" });
    expect(DEFAULT_RESTART_MODE).toBe("resume");
  });

  test("confirm:true, mode 'resume' ⇒ proceed resume", () => {
    expect(decideRestart({ confirm: true, mode: "resume" })).toEqual({
      proceed: true,
      mode: "resume",
    });
  });

  test("confirm:true, mode 'fresh' ⇒ proceed fresh", () => {
    expect(decideRestart({ confirm: true, mode: "fresh" })).toEqual({
      proceed: true,
      mode: "fresh",
    });
  });

  test("NO confirm ⇒ refuse 'unconfirmed' (the kill loses in-flight turn state)", () => {
    expect(decideRestart({})).toEqual({ proceed: false, reason: "unconfirmed" });
    expect(decideRestart({ mode: "fresh" })).toEqual({ proceed: false, reason: "unconfirmed" });
  });

  test("a non-true confirm is NOT accepted (truthy strings/1 don't pass the gate)", () => {
    for (const c of ["true", 1, "yes", {}, [], "on"]) {
      expect(decideRestart({ confirm: c })).toEqual({ proceed: false, reason: "unconfirmed" });
    }
  });

  test("confirm:true but an unknown mode ⇒ 'bad-mode' (never a silent default)", () => {
    expect(decideRestart({ confirm: true, mode: "wipe" })).toEqual({
      proceed: false,
      reason: "bad-mode",
    });
    expect(decideRestart({ confirm: true, mode: 7 })).toEqual({
      proceed: false,
      reason: "bad-mode",
    });
  });

  test("BOTH modes are gated: fresh-restart with no confirm is refused too", () => {
    // The fresh path is just as destructive of in-flight state — same gate.
    expect(decideRestart({ confirm: false, mode: "fresh" })).toEqual({
      proceed: false,
      reason: "unconfirmed",
    });
  });
});

// ── AC7.2 — procAliveFor: a fresh /proc-gone probe (procStart reuse guard) ───────
describe("AC7.2 procAliveFor (fresh /proc death probe)", () => {
  function statLine(starttime: string): string {
    const fields3plus = ["S", "1", "1", "1", "0", "-1", "0", "0", "0", "0", "0", "0", "0", "0", "0", "20", "0", "1", "0", starttime, "0", "0", "0"];
    return `12345 (claude) ${fields3plus.join(" ")}\n`;
  }

  test("a live pid whose /proc starttime matches ⇒ alive (still draining — wait)", () => {
    expect(procAliveFor(12345, "ps-1", () => statLine("ps-1"))).toBe(true);
  });

  test("a pid whose /proc is GONE (read throws) ⇒ not alive (dead)", () => {
    expect(
      procAliveFor(12345, "ps-1", () => {
        throw new Error("ENOENT");
      }),
    ).toBe(false);
  });

  test("a RECYCLED pid (starttime mismatch) ⇒ not alive — it isn't our process", () => {
    expect(procAliveFor(12345, "ps-1", () => statLine("OTHER"))).toBe(false);
  });

  test("no pid known ⇒ not alive (nothing to wait on; tmux-gone confirms the pane)", () => {
    expect(procAliveFor(undefined, "ps-1", () => statLine("ps-1"))).toBe(false);
  });
});

// ── AC7.2 — confirmKilled: kill rc branch + confirmed-dead by direct probes ──────
describe("AC7.2 confirmKilled (kill rc + /proc-gone + tmux-gone, never snapshot)", () => {
  function baseKill(over: Partial<KillDeps> = {}): KillDeps {
    return {
      killSession: async () => 0,
      procAlive: () => false,
      tmuxLive: async () => false,
      timeoutMs: 5_000,
      pollMs: 100,
      now: () => NOW,
      sleep: async () => {},
      ...over,
    };
  }

  test("tmux refuses the kill (rc≠0) ⇒ kill-refused, NEVER confirmed dead (no relaunch upstream)", async () => {
    let probed = false;
    const out = await confirmKilled(
      baseKill({
        killSession: async () => 1,
        procAlive: () => {
          probed = true;
          return false;
        },
      }),
    );
    expect(out).toEqual({ dead: false, reason: "kill-refused", rc: 1 });
    // rc branched FIRST — we never even consulted the death probes.
    expect(probed).toBe(false);
  });

  test("kill accepted AND both probes gone ⇒ dead (confirmed by direct probes)", async () => {
    const out = await confirmKilled(baseKill());
    expect(out).toEqual({ dead: true });
  });

  test("/proc still has the pid ⇒ NOT dead within budget ⇒ still-alive (never relaunch onto a live writer)", async () => {
    // The pid never leaves /proc — confirmed-dead must time out, not be assumed.
    const out = await confirmKilled(
      baseKill({
        procAlive: () => true, // always still in /proc
        timeoutMs: 300,
        pollMs: 100,
        // advance the injected clock so the deadline is actually reached
        now: (() => {
          let t = NOW;
          return () => (t += 100);
        })(),
      }),
    );
    expect(out).toEqual({ dead: false, reason: "still-alive" });
  });

  test("tmux pane lingers after the pid is gone ⇒ still NOT dead until the pane clears too", async () => {
    const out = await confirmKilled(
      baseKill({
        procAlive: () => false,
        tmuxLive: async () => true, // pane still present
        timeoutMs: 300,
        pollMs: 100,
        now: (() => {
          let t = NOW;
          return () => (t += 100);
        })(),
      }),
    );
    expect(out).toEqual({ dead: false, reason: "still-alive" });
  });

  test("the probes are read FRESH each poll — a pid that clears mid-wait is then seen dead", async () => {
    let alive = true; // still draining on the first poll, gone by the second
    const out = await confirmKilled(
      baseKill({
        procAlive: () => {
          const wasAlive = alive;
          alive = false; // clears before the next poll
          return wasAlive;
        },
        tmuxLive: async () => false,
        timeoutMs: 5_000,
        pollMs: 100,
        now: (() => {
          let t = NOW;
          return () => (t += 50); // never hits the deadline before the pid clears
        })(),
      }),
    );
    expect(out).toEqual({ dead: true });
  });
});

// ── AC7.1/AC7.3 — the restart orchestration over injected effects ────────────────
describe("restart orchestration (restartSession)", () => {
  function baseDeps(over: Partial<RestartDeps> = {}): RestartDeps {
    return {
      confirmKilled: async () => ({ dead: true }),
      readBackCwd: async () => "/home/you/proj",
      issueResume: async (uuid): Promise<SpawnResult> => ({
        ok: true,
        tmuxSession: sessionName(uuid),
        transcriptPath: `/p/${uuid}.jsonl`,
      }),
      issueFresh: async (uuid): Promise<SpawnResult> => ({
        ok: true,
        tmuxSession: sessionName(uuid),
        transcriptPath: `/p/${uuid}.jsonl`,
      }),
      newUuid: () => "ffff9999-0000-1111-2222-333344445555",
      ...over,
    };
  }

  test("AC7.3 resume-restart relaunches --resume <SAME uuid>; fresh issuer never runs", async () => {
    const resumed: { uuid: string; cwd: string }[] = [];
    let freshRan = false;
    const out = await restartSession(UUID, "resume", baseDeps({
      issueResume: async (uuid, cwd) => {
        resumed.push({ uuid, cwd });
        return { ok: true, tmuxSession: sessionName(uuid), transcriptPath: `/p/${uuid}.jsonl` };
      },
      issueFresh: async () => {
        freshRan = true;
        return { ok: false, reason: "confirm-timeout" };
      },
    }));
    expect(out).toEqual({
      ok: true,
      mode: "resume",
      uuid: UUID, // SAME conversation
      tmuxSession: sessionName(UUID),
      transcriptPath: `/p/${UUID}.jsonl`,
    });
    expect(resumed).toEqual([{ uuid: UUID, cwd: "/home/you/proj" }]);
    expect(freshRan).toBe(false);
  });

  test("AC7.3 fresh-restart spawns a NEW --session-id in the SAME cwd; resume issuer never runs", async () => {
    const NEW = "ffff9999-0000-1111-2222-333344445555";
    const spawned: { uuid: string; cwd: string }[] = [];
    let resumeRan = false;
    const out = await restartSession(UUID, "fresh", baseDeps({
      newUuid: () => NEW,
      issueResume: async () => {
        resumeRan = true;
        return { ok: false, reason: "confirm-timeout" };
      },
      issueFresh: async (uuid, cwd) => {
        spawned.push({ uuid, cwd });
        return { ok: true, tmuxSession: sessionName(uuid), transcriptPath: `/p/${uuid}.jsonl` };
      },
    }));
    expect(out).toEqual({
      ok: true,
      mode: "fresh",
      uuid: NEW, // a NEW conversation uuid
      tmuxSession: sessionName(NEW),
      transcriptPath: `/p/${NEW}.jsonl`,
    });
    // Same cwd as the old session; a brand-new uuid (≠ old).
    expect(spawned).toEqual([{ uuid: NEW, cwd: "/home/you/proj" }]);
    expect(NEW).not.toBe(UUID);
    expect(resumeRan).toBe(false);
  });

  test("AC7.2 a kill-refused stops BEFORE any relaunch (no spawn on an unconfirmed kill)", async () => {
    let relaunched = false;
    const out = await restartSession(UUID, "resume", baseDeps({
      confirmKilled: async () => ({ dead: false, reason: "kill-refused", rc: 1 }),
      issueResume: async () => {
        relaunched = true;
        return { ok: true, tmuxSession: "x", transcriptPath: "y" };
      },
    }));
    expect(out).toEqual({ ok: false, reason: "kill-refused", rc: 1 });
    expect(relaunched).toBe(false);
  });

  test("AC7.2 a still-alive process stops BEFORE relaunch (never a second writer)", async () => {
    let relaunched = false;
    const out = await restartSession(UUID, "fresh", baseDeps({
      confirmKilled: async () => ({ dead: false, reason: "still-alive" }),
      issueFresh: async () => {
        relaunched = true;
        return { ok: true, tmuxSession: "x", transcriptPath: "y" };
      },
    }));
    expect(out).toEqual({ ok: false, reason: "still-alive" });
    expect(relaunched).toBe(false);
  });

  test("an unreadable cwd surfaces cwd-unreadable, no relaunch", async () => {
    let relaunched = false;
    const out = await restartSession(UUID, "resume", baseDeps({
      readBackCwd: async () => undefined,
      issueResume: async () => {
        relaunched = true;
        return { ok: true, tmuxSession: "x", transcriptPath: "y" };
      },
    }));
    expect(out).toEqual({ ok: false, reason: "cwd-unreadable" });
    expect(relaunched).toBe(false);
  });

  test("a relaunch collision/timeout surfaces spawn-failed", async () => {
    const out = await restartSession(UUID, "resume", baseDeps({
      issueResume: async () => ({ ok: false, reason: "collision", stderr: "dup" }),
    }));
    expect(out).toEqual({ ok: false, reason: "spawn-failed", detail: "collision" });
  });

  test("a thrown relaunch (e.g. missing-binary assertion) surfaces spawn-failed with the message", async () => {
    const out = await restartSession(UUID, "fresh", baseDeps({
      issueFresh: async () => {
        throw new Error("claude binary not found");
      },
    }));
    expect(out).toEqual({ ok: false, reason: "spawn-failed", detail: "claude binary not found" });
  });

  test("the kill is sequenced BEFORE the relaunch (kill runs, then spawn)", async () => {
    const order: string[] = [];
    await restartSession(UUID, "resume", baseDeps({
      confirmKilled: async () => {
        order.push("kill");
        return { dead: true };
      },
      issueResume: async (uuid) => {
        order.push("relaunch");
        return { ok: true, tmuxSession: sessionName(uuid), transcriptPath: `/p/${uuid}.jsonl` };
      },
    }));
    expect(order).toEqual(["kill", "relaunch"]);
  });
});

// ── AC7.3 — fresh-restart leaves the OLD transcript untouched (on disk) ──────────
describe("AC7.3 fresh-restart does NOT delete the old transcript", () => {
  test("after a fresh-restart the old <uuid>.jsonl is byte-identical (the orchestration never touches it)", async () => {
    const root = mkdtempSync(join(tmpdir(), "bifrost-restart-"));
    const projectsDir = join(root, "projects");
    const slug = "/home/you/proj".replace(/[/.]/g, "-");
    const dir = join(projectsDir, slug);
    mkdirSync(dir, { recursive: true });
    const oldPath = join(dir, `${UUID}.jsonl`);
    const oldContent =
      [
        JSON.stringify({ type: "operation", sessionId: UUID }),
        JSON.stringify({ type: "user", cwd: "/home/you/proj", message: { role: "user", content: "history" } }),
      ].join("\n") + "\n";
    writeFileSync(oldPath, oldContent);

    const NEW = "ffff9999-0000-1111-2222-333344445555";
    const out = await restartSession(UUID, "fresh", {
      confirmKilled: async () => ({ dead: true }),
      readBackCwd: async () => "/home/you/proj",
      issueResume: async () => ({ ok: false, reason: "confirm-timeout" }),
      // The fresh spawn writes the NEW uuid's transcript — never the old one.
      issueFresh: async (uuid, _cwd) => {
        writeFileSync(join(dir, `${uuid}.jsonl`), JSON.stringify({ type: "operation", sessionId: uuid }) + "\n");
        return { ok: true, tmuxSession: sessionName(uuid), transcriptPath: join(dir, `${uuid}.jsonl`) };
      },
      newUuid: () => NEW,
    });

    expect(out.ok).toBe(true);
    // The OLD transcript is still present and byte-identical — fresh never deletes it.
    expect(existsSync(oldPath)).toBe(true);
    expect(readFileSync(oldPath, "utf8")).toBe(oldContent);
    // A NEW transcript exists for the fresh conversation.
    expect(existsSync(join(dir, `${NEW}.jsonl`))).toBe(true);
  });
});

// ── AC7.2 — throwaway-tmux integration: real kill-session rc + confirmed-dead ─────
// Mirrors confirm.test.ts / resume.test.ts: a throwaway tmux session running `sleep`
// stands in for a live claude (NEVER real claude). We kill it via the real
// `tmux kill-session` and confirm-dead by the real `tmux has-session` probe; the
// /proc probe is the throwaway's own pane pid. All throwaway sessions are killed in
// afterEach.
async function hasTmux(): Promise<boolean> {
  try {
    const p = Bun.spawn(["tmux", "-V"], { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}
const td = (await hasTmux()) ? describe : describe.skip;

td("AC7.2 throwaway-tmux kill sequence", () => {
  const killed: string[] = [];
  afterEach(async () => {
    for (const name of killed.splice(0)) {
      const p = Bun.spawn(["tmux", "kill-session", "-t", name], { stdout: "ignore", stderr: "ignore" });
      await p.exited;
    }
  });

  async function tmuxHasSession(name: string): Promise<boolean> {
    const p = Bun.spawn(["tmux", "has-session", "-t", `=${name}`], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await p.exited) === 0;
  }

  test("kill-session on a LIVE throwaway pane confirms dead by the real has-session probe", async () => {
    const uuid = "cccc0000-1111-2222-3333-444455556666";
    const name = sessionName(uuid);
    killed.push(name); // safety net even though we kill it below

    // Stand-in live session: a throwaway tmux pane running `sleep` (never real claude).
    const create = Bun.spawn(["tmux", "new-session", "-d", "-s", name, "sleep", "30"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await create.exited).toBe(0);
    expect(await tmuxHasSession(name)).toBe(true); // genuinely live

    // Sequence the kill by direct probes: real kill-session rc + real has-session gone.
    // procAlive is forced false here (the pane's process is tmux-managed; the tmux probe
    // is the authoritative pane-gone signal for a throwaway). The kill rc must be 0 and
    // the session must vanish from the live tmux set.
    const out = await confirmKilled({
      killSession: async () => {
        const p = Bun.spawn(["tmux", "kill-session", "-t", `=${name}`], {
          stdout: "ignore",
          stderr: "ignore",
        });
        return await p.exited;
      },
      procAlive: () => false,
      tmuxLive: () => tmuxHasSession(name),
      timeoutMs: 5_000,
      pollMs: 100,
    });
    expect(out).toEqual({ dead: true });
    // Confirmed dead by the DIRECT probe — the pane is genuinely gone.
    expect(await tmuxHasSession(name)).toBe(false);
  });

  test("kill-session on a NON-EXISTENT session returns rc≠0 ⇒ kill-refused (never confirmed dead)", async () => {
    const uuid = "bbbb0000-1111-2222-3333-444455556666";
    const name = sessionName(uuid);
    // No such session — tmux kill-session must fail with a non-zero rc.
    const out = await confirmKilled({
      killSession: async () => {
        const p = Bun.spawn(["tmux", "kill-session", "-t", `=${name}`], {
          stdout: "ignore",
          stderr: "ignore",
        });
        return await p.exited;
      },
      procAlive: () => false,
      tmuxLive: () => tmuxHasSession(name),
      timeoutMs: 1_000,
      pollMs: 100,
    });
    expect(out.dead).toBe(false);
    if (!out.dead) {
      expect(out.reason).toBe("kill-refused");
      if (out.reason === "kill-refused") expect(out.rc).not.toBe(0);
    }
  });
});
