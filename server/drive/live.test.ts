import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headDiverged, resumeDecision, sessionStream, makeTranscriptReader } from "./live";

// The rewrite detector: under append-only writes the head only GROWS (old head
// stays a prefix); a diverging head means an in-place rewrite/replace → the
// reader must re-baseline rather than splice appended garbage (audit L3).
describe("headDiverged", () => {
  test("a grown head (append) is NOT divergence — old is a prefix of new", () => {
    expect(headDiverged('{"a":1}', '{"a":1}\n{"b":2}')).toBe(false);
  });

  test("identical heads are not divergence", () => {
    expect(headDiverged('{"a":1}', '{"a":1}')).toBe(false);
  });

  test("a changed first byte IS divergence (rewrite/replace)", () => {
    expect(headDiverged('{"a":1}\n{"b":2}', '{"z":9}\n{"b":2}')).toBe(true);
  });

  test("a change past the shorter length still diverges within the common prefix only", () => {
    // common prefix identical, extra bytes differ → NOT divergence (an append)
    expect(headDiverged('{"a":1}', '{"a":1}XYZ')).toBe(false);
    // common prefix differs → divergence
    expect(headDiverged('{"a":1}XYZ', '{"a":2}ABC')).toBe(true);
  });

  test("an empty side is treated as no-signal (first read / unreadable) → not divergence", () => {
    expect(headDiverged("", '{"a":1}')).toBe(false);
    expect(headDiverged('{"a":1}', "")).toBe(false);
  });
});

// Resumable reconnect: the client passes the message count it already holds so
// a redial ships only the delta, not the whole transcript (the mobile re-ship
// cliff). Re-send from resumeFrom-1 to refresh a possibly-grown open turn.
describe("resumeDecision", () => {
  test("first connect (resumeFrom 0) → full state", () => {
    expect(resumeDecision(10, 0)).toEqual({ kind: "state" });
  });

  test("reconnect within bounds → append from resumeFrom-1 (refreshes the last held turn)", () => {
    expect(resumeDecision(10, 7)).toEqual({ kind: "append", fromIndex: 6 });
  });

  test("nothing new since the client's count → still an append of just the last turn", () => {
    expect(resumeDecision(10, 10)).toEqual({ kind: "append", fromIndex: 9 });
  });

  test("server has FEWER than the client claims (truncate/rewrite) → full state re-baseline", () => {
    expect(resumeDecision(3, 8)).toEqual({ kind: "state" });
  });

  test("a bogus/negative cursor is safe → full state", () => {
    expect(resumeDecision(10, -5)).toEqual({ kind: "state" });
  });
});

describe("makeTranscriptReader — resumable reconnect delta", () => {
  const L = (o: unknown) => JSON.stringify(o) + "\n";
  const twoTurns =
    L({ type: "user", uuid: "u1", message: { role: "user", content: "first" } }) +
    L({ type: "user", uuid: "u2", message: { role: "user", content: "second" } });

  test("resumeFrom past the client's tail ships an append, not the whole transcript", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bifrost-resume-"));
    const path = join(dir, "s.jsonl");
    await Bun.write(path, twoTurns);
    const read = makeTranscriptReader("sid", path, 2); // client already holds both
    const first = await read();
    expect(first).toContain("event: append");
    expect(first).toContain('"fromIndex":1'); // re-sends the last held turn onward
    expect(first).toContain("second");
    expect(first).not.toContain("event: state");
    await rm(dir, { recursive: true, force: true });
  });

  test("resumeFrom beyond the file falls back to a full state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bifrost-resume-"));
    const path = join(dir, "s.jsonl");
    await Bun.write(path, twoTurns);
    const read = makeTranscriptReader("sid", path, 9); // client claims more than exists
    const first = await read();
    expect(first).toContain("event: state");
    expect(first).toContain("first");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("sessionStream — transcript-less live session (fresh spawn)", () => {
  const readFrames = (res: Response) => {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    return {
      next: async (): Promise<string> => {
        while (!buf.includes("\n\n")) {
          const { value, done } = await reader.read();
          if (done) throw new Error("stream ended");
          buf += dec.decode(value);
        }
        const i = buf.indexOf("\n\n");
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        return frame;
      },
      cancel: () => reader.cancel(),
    };
  };

  test("streams an empty state immediately, then adopts the transcript when it appears", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bifrost-live-"));
    const path = join(dir, "s.jsonl");
    let resolved: string | undefined;
    const res = sessionStream("sid-pending", () => resolved, null, async () => true, 40);
    const frames = readFrames(res);

    // Connected + empty NOW — the client shows "ready", not "loading…".
    const first = await frames.next();
    expect(first).toContain("event: state");
    expect(first).toContain('"messages":[]');

    // First turn writes the file; the resolver learns the path (collector scan).
    await Bun.write(
      path,
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "first prompt" } }) + "\n",
    );
    resolved = path;

    const second = await frames.next();
    expect(second).toContain("event: state");
    expect(second).toContain("first prompt");

    await frames.cancel();
    await rm(dir, { recursive: true, force: true });
  });

  test("a session whose transcript exists from the start streams it on connect (unchanged contract)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bifrost-live-"));
    const path = join(dir, "s.jsonl");
    await Bun.write(
      path,
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "already here" } }) + "\n",
    );
    const res = sessionStream("sid-existing", () => path, null, async () => true, 40);
    const frames = readFrames(res);
    const first = await frames.next();
    expect(first).toContain("event: state");
    expect(first).toContain("already here");
    await frames.cancel();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("watch-poll backstop — the beat re-reads so a missed watch event still delivers", () => {
  // The reader is the backstop's engine: polling it (what the beat does) must
  // deliver an append even when no fs.watch event fired, and never re-ship it.
  test("polling the reader delivers each append exactly once (no watch involved)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bifrost-backstop-"));
    const path = join(dir, "s.jsonl");
    const L = (o: unknown) => JSON.stringify(o) + "\n";
    await Bun.write(path, L({ type: "user", uuid: "u1", message: { role: "user", content: "one" } }));
    const read = makeTranscriptReader("sid", path);

    const first = await read(); // full state on first poll
    expect(first).toContain("event: state");
    expect(first).toContain("one");

    // No watcher — just append and poll again (what a missed-watch beat does).
    await Bun.write(
      path,
      (await Bun.file(path).text()) +
        L({ type: "user", uuid: "u2", message: { role: "user", content: "two" } }),
    );
    const second = await read();
    expect(second).toContain("event: append");
    expect(second).toContain("two");

    // A poll with nothing new is a cheap no-op (null) — the unchanged-file case
    // the beat hits every 25s on an idle session.
    expect(await read()).toBeNull();
    expect(await read()).toBeNull();

    await rm(dir, { recursive: true, force: true });
  });

  test("a live stream still delivers appends when beat backstop is the only trigger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bifrost-backstop-"));
    const path = join(dir, "s.jsonl");
    const L = (o: unknown) => JSON.stringify(o) + "\n";
    await Bun.write(path, L({ type: "user", uuid: "u1", message: { role: "user", content: "hi" } }));
    // Tiny beat so the backstop fires fast; the append below is picked up by the
    // beat's push even though we never touch fs.watch semantics in the assert.
    const res = sessionStream("sid", () => path, null, async () => true, 1000, 60);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const nextFrame = async (): Promise<string> => {
      while (!buf.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buf += dec.decode(value);
      }
      const i = buf.indexOf("\n\n");
      const f = buf.slice(0, i);
      buf = buf.slice(i + 2);
      return f;
    };
    const first = await nextFrame();
    expect(first).toContain("event: state");
    await Bun.write(
      path,
      (await Bun.file(path).text()) +
        L({ type: "user", uuid: "u2", message: { role: "user", content: "later" } }),
    );
    // Collect frames until the append arrives (via watch or the 60ms beat — both
    // are valid backstops; the point is it MUST arrive, not be frozen).
    let got = "";
    for (let i = 0; i < 20 && !got.includes("later"); i++) got = await nextFrame();
    expect(got).toContain("later");
    await reader.cancel();
    await rm(dir, { recursive: true, force: true });
  });
});
