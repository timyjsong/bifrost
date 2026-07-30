import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findConfirmedSession,
  isTrustPrompt,
  issueSpawn,
  readTranscriptCwd,
} from "./confirm";
import { sessionName } from "./spawn";

// ── Throwaway-tmux harness (never real claude; panes run `sleep`). ─────────────
async function tmuxOut(args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "ignore" });
  const code = await p.exited;
  return { code, out: await new Response(p.stdout).text() };
}
async function hasTmux(): Promise<boolean> {
  try {
    const p = Bun.spawn(["tmux", "-V"], { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}
const d = (await hasTmux()) ? describe : describe.skip;

// ── readTranscriptCwd (still used by the resume route's read-back) ─────────────
describe("readTranscriptCwd", () => {
  test("pulls the top-level cwd from the transcript head", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bifrost-confirm-"));
    const path = join(dir, "t.jsonl");
    writeFileSync(
      path,
      JSON.stringify({ type: "operation", sessionId: "x" }) +
        "\n" +
        JSON.stringify({ type: "user", cwd: "/home/you/proj" }) +
        "\n",
    );
    expect(await readTranscriptCwd(path)).toBe("/home/you/proj");
  });

  test("returns undefined for a missing file", async () => {
    expect(await readTranscriptCwd("/no/such/file.jsonl")).toBeUndefined();
  });
});

// ── findConfirmedSession (the eager pid-file confirm + cwd identity) ───────────
describe("findConfirmedSession (pid-file confirm, injected io)", () => {
  const sessionsDir = "/fake/sessions";
  const UUID = "11112222-3333-4444-5555-666677778888";
  // pidMatchesStart with no procStart returns true iff readStat doesn't throw.
  const alive = (_p: number) => "9 (claude) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n";
  const dead = (_p: number) => {
    throw new Error("/proc gone");
  };
  function io(
    files: Record<string, Record<string, unknown>>,
    stat: (p: number) => string = alive,
  ) {
    return {
      readDir: async () => Object.keys(files),
      readFile: (p: string) => JSON.stringify(files[p.split("/").pop() as string]),
      readStat: stat,
    };
  }

  test("confirms (returns the pid) when a live pid-file matches uuid AND cwd", async () => {
    const r = await findConfirmedSession(
      sessionsDir,
      UUID,
      "/home/you/proj",
      io({ "5.json": { pid: 5, sessionId: UUID, cwd: "/home/you/proj" } }),
    );
    expect(r).toBe(5);
  });

  test("refuses on a cwd mismatch — identity guard (M7/H6)", async () => {
    const r = await findConfirmedSession(
      sessionsDir,
      UUID,
      "/home/you/proj",
      io({ "5.json": { pid: 5, sessionId: UUID, cwd: "/home/you/OTHER" } }),
    );
    expect(r).toBeUndefined();
  });

  test("undefined while no pid-file names this uuid (still booting)", async () => {
    const r = await findConfirmedSession(
      sessionsDir,
      UUID,
      "/home/you/proj",
      io({ "9.json": { pid: 9, sessionId: "someone-else", cwd: "/home/you/proj" } }),
    );
    expect(r).toBeUndefined();
  });

  test("undefined when the matching pid-file's process is dead", async () => {
    const r = await findConfirmedSession(
      sessionsDir,
      UUID,
      "/home/you/proj",
      io({ "5.json": { pid: 5, sessionId: UUID, cwd: "/home/you/proj" } }, dead),
    );
    expect(r).toBeUndefined();
  });

  test("undefined when the sessions dir can't be read (not created yet)", async () => {
    const r = await findConfirmedSession(sessionsDir, UUID, "/home/you/proj", {
      readDir: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(r).toBeUndefined();
  });
});

// ── isTrustPrompt (the first-run trust prompt detector) ────────────────────────
describe("isTrustPrompt", () => {
  test("detects the first-run trust prompt", () => {
    const pane =
      " Quick safety check: Is this a project you created or one you trust?\n" +
      " ❯ 1. Yes, I trust this folder\n   2. No, exit\n";
    expect(isTrustPrompt(pane)).toBe(true);
  });

  test("false on a normal idle pane", () => {
    expect(isTrustPrompt('❯ Try "fix typecheck errors"\n  ← for agents\n')).toBe(false);
  });
});

// ── issueSpawn — real tmux pane (rc branch + reap), injected confirm/trust ─────
let throwaway: string[] = [];
d("issueSpawn (throwaway tmux pane; injected confirm/trust)", () => {
  afterEach(async () => {
    for (const s of throwaway) await tmuxOut(["kill-session", "-t", s]);
    throwaway = [];
  });

  function argvFor(name: string): string[] {
    return ["tmux", "new-session", "-d", "-s", name, "-c", "/home/you", "sleep", "300"];
  }

  test("rc==0 + confirm returns a pid ⇒ ok with the live tmux name + eventual path", async () => {
    const uuid = "12340000-0000-4000-8000-000000000001";
    const name = sessionName(uuid);
    throwaway.push(name);
    const res = await issueSpawn(argvFor(name), uuid, "/home/you", {
      projectsDir: "/p",
      sessionsDir: "/s",
      timeoutMs: 5000,
      pollMs: 10,
      confirm: async () => 4242,
      handleTrust: async () => {},
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.tmuxSession).toBe(name);
      expect(res.transcriptPath).toContain(`${uuid}.jsonl`);
    }
    expect((await tmuxOut(["has-session", "-t", name])).code).toBe(0);
  });

  test("rc≠0 (name collision) ⇒ collision, NEVER polls confirm, incumbent untouched", async () => {
    const uuid = "12340000-0000-4000-8000-000000000002";
    const name = sessionName(uuid);
    throwaway.push(name);
    await tmuxOut(["new-session", "-d", "-s", name, "-x", "80", "-y", "24"]);
    let confirmed = false;
    const res = await issueSpawn(argvFor(name), uuid, "/home/you", {
      projectsDir: "/p",
      sessionsDir: "/s",
      timeoutMs: 5000,
      pollMs: 10,
      confirm: async () => {
        confirmed = true;
        return 1;
      },
      handleTrust: async () => {},
    });
    expect(res).toMatchObject({ ok: false, reason: "collision" });
    expect(confirmed).toBe(false); // M6: collision branch never enters the poll
    expect((await tmuxOut(["has-session", "-t", name])).code).toBe(0);
  });

  test("rc==0 but confirm never resolves ⇒ confirm-timeout AND the pane is reaped", async () => {
    const uuid = "12340000-0000-4000-8000-000000000003";
    const name = sessionName(uuid);
    throwaway.push(name);
    let t = 0;
    const res = await issueSpawn(argvFor(name), uuid, "/home/you", {
      projectsDir: "/p",
      sessionsDir: "/s",
      timeoutMs: 100,
      pollMs: 10,
      now: () => {
        const v = t;
        t += 60; // deadline=100 ⇒ exits after one poll
        return v;
      },
      sleep: async () => {},
      confirm: async () => undefined,
      handleTrust: async () => {},
    });
    expect(res).toEqual({ ok: false, reason: "confirm-timeout" });
    expect((await tmuxOut(["has-session", "-t", name])).code).not.toBe(0); // reaped
  });

  test("answers the trust prompt while confirm is pending, then confirms", async () => {
    const uuid = "12340000-0000-4000-8000-000000000004";
    const name = sessionName(uuid);
    throwaway.push(name);
    let polls = 0;
    let trustCalls = 0;
    const res = await issueSpawn(argvFor(name), uuid, "/home/you", {
      projectsDir: "/p",
      sessionsDir: "/s",
      timeoutMs: 5000,
      pollMs: 1,
      confirm: async () => (++polls >= 2 ? 7 : undefined), // undefined first, pid second
      handleTrust: async () => {
        trustCalls++;
      },
    });
    expect(res.ok).toBe(true);
    expect(trustCalls).toBeGreaterThanOrEqual(1); // trust handler ran during the pending poll
  });
});
