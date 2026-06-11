import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveMaxInFlight,
  extractConversation,
  summarizeSession,
  summarizeState,
  _setTestSeams,
  _resetQueueForTest,
  type SummaryResult,
} from "./summarize";
import type { AtriumConfig } from "./config";

const cfg = (over: Partial<AtriumConfig["summarize"]> = {}): AtriumConfig =>
  ({
    summarize: {
      claudeBin: "/bin/false",
      model: "sonnet",
      effort: "low",
      fastStartArgs: [],
      scratchDir: "/tmp/nonexistent-scratch",
      cacheDir: mkdtempSync(join(tmpdir(), "atrium-cache-")),
      perJobMb: 250,
      ramShare: 0.33,
      memReservePct: 0.15,
      maxInFlightCap: 12,
      maxQueue: 40,
      timeoutMs: 5000,
      ...over,
    },
  }) as AtriumConfig;

describe("deriveMaxInFlight scales with the box", () => {
  const c = cfg();
  test("small boxes clamp to the floor of 2", () => {
    expect(deriveMaxInFlight(c, 1024)).toBe(2);
    expect(deriveMaxInFlight(c, 2048)).toBe(2);
  });
  test("3.8G box derives 5", () => {
    expect(deriveMaxInFlight(c, 3891)).toBe(5);
  });
  test("big boxes clamp to the cap", () => {
    expect(deriveMaxInFlight(c, 65536)).toBe(12);
  });
  test("unknown total falls back to the floor", () => {
    expect(deriveMaxInFlight(c, 0)).toBe(2);
  });
});

describe("extractConversation", () => {
  test("keeps typed prompts and assistant text, skips wrappers and tool noise", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "atrium-x-")), "t.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "real question" },
        }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "Caveat: wrapper" },
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t", content: "x" }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "real answer" }],
          },
        }),
      ].join("\n"),
    );
    const convo = await extractConversation(path);
    expect(convo).toContain("User: real question");
    expect(convo).toContain("Assistant: real answer");
    expect(convo).not.toContain("Caveat");
    expect(convo).not.toContain("tool_result");
  });
  test("caps long conversations with an ellipsis marker", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "atrium-y-")), "t.jsonl");
    const big = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify({
        type: "user",
        message: { role: "user", content: `prompt ${i} ${"x".repeat(500)}` },
      }),
    ).join("\n");
    writeFileSync(path, big);
    const convo = await extractConversation(path);
    expect(convo.length).toBeLessThan(25_000);
    expect(convo).toContain("[... middle of session omitted for length ...]");
  });
});

describe("queue mechanics (with injected seams)", () => {
  let resolvers: Map<string, (r: SummaryResult) => void>;
  let started: string[];
  let mem: { totalMb: number; availMb: number };

  beforeEach(() => {
    _resetQueueForTest();
    resolvers = new Map();
    started = [];
    mem = { totalMb: 3891, availMb: 2000 }; // healthy 3.8G box -> 5 slots
    _setTestSeams({
      mem: () => mem,
      lookup: { path: (id) => `/fake/${id}.jsonl`, mtime: () => 1 },
      job: (_c, id) => {
        started.push(id);
        return new Promise<SummaryResult>((res) => resolvers.set(id, res));
      },
    });
  });

  const finish = (id: string) =>
    resolvers.get(id)!({ summary: "s", asOf: 1, cached: false });

  test("runs up to the derived limit, queues the rest FIFO, drains on completion", async () => {
    const c = cfg({ cacheDir: mkdtempSync(join(tmpdir(), "atrium-q-")) });
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    const promises = ids.map((id) => summarizeSession(c, id));
    await Bun.sleep(1);
    expect(started.length).toBe(5); // derived limit on 3.8G
    expect(summarizeState().queued).toEqual(["f", "g"]);
    finish("a");
    await Bun.sleep(1);
    expect(started).toContain("f"); // FIFO: f before g
    expect(started.length).toBe(6);
    finish("b");
    await Bun.sleep(1);
    expect(started).toContain("g");
    for (const id of ["c", "d", "e", "f", "g"]) finish(id);
    await Promise.all(promises);
    expect(summarizeState().active.length).toBe(0);
  });

  test("dedupes concurrent requests for the same session", async () => {
    const c = cfg({ cacheDir: mkdtempSync(join(tmpdir(), "atrium-q2-")) });
    const p1 = summarizeSession(c, "same");
    const p2 = summarizeSession(c, "same");
    await Bun.sleep(1);
    expect(started.filter((s) => s === "same").length).toBe(1);
    finish("same");
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
  });

  test("holds the queue when memory is below the reserve, resumes when freed", async () => {
    const c = cfg({ cacheDir: mkdtempSync(join(tmpdir(), "atrium-q3-")) });
    mem = { totalMb: 3891, availMb: 100 }; // below 15% reserve (~584M)
    const p = summarizeSession(c, "held");
    await Bun.sleep(5);
    expect(started).not.toContain("held");
    expect(summarizeState().queued).toContain("held");
    mem = { totalMb: 3891, availMb: 2000 }; // memory freed; pump retries on timer
    await Bun.sleep(3000);
    expect(started).toContain("held");
    finish("held");
    await p;
  }, 10_000);

  test("rejects beyond the queue depth cap", async () => {
    const c = cfg({
      cacheDir: mkdtempSync(join(tmpdir(), "atrium-q4-")),
      maxQueue: 6,
    });
    const ps = ["1", "2", "3", "4", "5", "6"].map((id) =>
      summarizeSession(c, id),
    );
    await Bun.sleep(1);
    await expect(summarizeSession(c, "overflow")).rejects.toThrow(
      /queue is full/,
    );
    for (const id of ["1", "2", "3", "4", "5"]) finish(id);
    await Bun.sleep(1); // "6" starts once a slot frees
    finish("6");
    await Promise.all(ps);
  });

  test("unknown session rejects without queueing", async () => {
    _setTestSeams({
      lookup: { path: () => undefined, mtime: () => undefined },
    });
    await expect(summarizeSession(cfg(), "ghost")).rejects.toThrow(
      /unknown session/,
    );
  });
});
