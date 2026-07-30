import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflightJobFor, killForPark, parseParkLog, queuedOpPending } from "./sweeper";
import { tempDir } from "../testing/tmp";

describe("parseParkLog — the observe-log tail → entries (arming-readiness surface)", () => {
  const L = (o: unknown) => JSON.stringify(o) + "\n";
  const log =
    L({ at: 1, uuid: "a", mode: "observe", cwd: "/x", idleMs: 100 }) +
    L({ at: 2, uuid: "b", mode: "kill", cwd: "/y", idleMs: 200 }) +
    L({ at: 3, uuid: "c", mode: "observe", cwd: "/z", idleMs: 300 });

  test("returns entries newest-first, bounded to the limit", () => {
    const out = parseParkLog(log, 2);
    expect(out.map((e) => e.uuid)).toEqual(["c", "b"]);
  });

  test("skips a partial leading line (a byte-offset tail read) and corrupt lines", () => {
    const partial = 'ffff9999aaaa","mode":"observe"}\n' + log; // fragment from a mid-line slice
    const out = parseParkLog(partial + "not json\n", 50);
    expect(out.map((e) => e.uuid)).toEqual(["c", "b", "a"]);
  });

  test("ignores a well-formed line missing required fields", () => {
    const out = parseParkLog(L({ at: 9, mode: "observe" }) + log, 50);
    expect(out.every((e) => typeof e.uuid === "string")).toBe(true);
    expect(out.length).toBe(3);
  });

  test("empty log → empty", () => {
    expect(parseParkLog("", 50)).toEqual([]);
  });
});

describe("queuedOpPending — §3.3 hard-block (queued input dies on park)", () => {
  test("a queue record AFTER the last assistant turn blocks", () => {
    const tail = [
      '{"type":"user"}',
      '{"type":"assistant"}',
      '{"type":"queue-operation"}',
    ].join("\n");
    expect(queuedOpPending(tail)).toBe(true);
  });

  test("a queue record already consumed (assistant after it) does not block", () => {
    const tail = [
      '{"type":"queue-operation"}',
      '{"type":"assistant"}',
    ].join("\n");
    expect(queuedOpPending(tail)).toBe(false);
  });

  test("partial tail lines are tolerated", () => {
    expect(queuedOpPending('{"type":"assist\n{"type":"assistant"}')).toBe(false);
  });
});

describe("inflightJobFor — §3.2 hard-block", () => {
  test("an inFlight job owned by the uuid blocks; others don't", () => {
    const jobs = tempDir("bifrost-jobs-");
    mkdirSync(join(jobs, "j1"));
    writeFileSync(join(jobs, "j1", "state.json"), JSON.stringify({ inFlight: true, resumeSessionId: "u-1" }));
    mkdirSync(join(jobs, "j2"));
    writeFileSync(join(jobs, "j2", "state.json"), JSON.stringify({ inFlight: false, resumeSessionId: "u-2" }));
    expect(inflightJobFor("u-1", jobs)).toBe(true);
    expect(inflightJobFor("u-2", jobs)).toBe(false);
    expect(inflightJobFor("u-3", jobs)).toBe(false);
    expect(inflightJobFor("u-1", join(jobs, "missing"))).toBe(false);
  });
});

describe("killForPark — §8 mapping check + never-kill-over-live", () => {
  test("refuses a tmux name that isn't the session's own spawn name", async () => {
    const ok = await killForPark({
      uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      pid: 999999999,
      tmuxSession: "someone-elses-window",
      killPane: async () => 0,
    });
    expect(ok).toBe(false);
  });

  test("a matching name with an already-dead pid kills the window", async () => {
    let killed = "";
    const ok = await killForPark({
      uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      pid: 999999999, // no such /proc entry
      tmuxSession: "bifrost-spawn-aaaaaaaa",
      killPane: async (n) => {
        killed = n;
        return 0;
      },
      signal: () => {},
      sleep: async () => {},
    });
    expect(ok).toBe(true);
    expect(killed).toBe("bifrost-spawn-aaaaaaaa");
  });
});
