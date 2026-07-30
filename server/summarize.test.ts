import { describe, expect, test, beforeEach } from "bun:test";
import { writeFileSync } from "node:fs";
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
import type { BifrostConfig } from "./config";
import { tempDir } from "./testing/tmp";

const cfg = (over: Partial<BifrostConfig["summarize"]> = {}): BifrostConfig =>
  ({
    summarize: {
      claudeBin: "/bin/false",
      model: "sonnet",
      effort: "low",
      fastStartArgs: [],
      scratchDir: "/tmp/nonexistent-scratch",
      cacheDir: tempDir("bifrost-cache-"),
      perJobMb: 250,
      ramShare: 0.33,
      memReservePct: 0.15,
      maxInFlightCap: 12,
      maxQueue: 40,
      timeoutMs: 5000,
      ...over,
    },
  }) as BifrostConfig;

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

// The jobs are plain child processes, so they live in the SERVICE's cgroup, not
// the box. Sizing against the box let MemoryMax and maxInFlightCap drift apart
// with nothing enforcing the relationship — 2G/cap-12 would happily admit 12
// × 250MB jobs into a 2G ceiling and let the kernel sort it out.
describe("deriveMaxInFlight honours the cgroup ceiling when there is one", () => {
  const c = cfg();

  test("a 2G ceiling on a 23G box sizes to the ceiling, not the box", () => {
    // box alone would derive 30 (clamped to the cap); the ceiling allows 6.
    expect(deriveMaxInFlight(c, 23_400, null)).toBe(12);
    expect(deriveMaxInFlight(c, 23_400, 2048)).toBe(6);
  });

  test("memReservePct is held back for Bifrost's own footprint", () => {
    // 2048 * 0.85 = 1740.8 -> 6 jobs of 250MB, leaving room for the service.
    expect(deriveMaxInFlight(cfg({ memReservePct: 0.15 }), 23_400, 2048)).toBe(6);
    expect(deriveMaxInFlight(cfg({ memReservePct: 0.5 }), 23_400, 2048)).toBe(4);
  });

  test("the cap still wins when the ceiling is generous", () => {
    expect(deriveMaxInFlight(cfg({ maxInFlightCap: 4 }), 23_400, 8192)).toBe(4);
  });

  // The [2, …] floor exists so an unreadable /proc/meminfo still makes progress.
  // Against a REAL ceiling it must not apply: forcing a second job into a
  // ceiling that fits one is the exact overcommit this is meant to prevent.
  test("a ceiling too small for two jobs yields one, not the box floor of two", () => {
    expect(deriveMaxInFlight(c, 23_400, 400)).toBe(1);
    expect(deriveMaxInFlight(c, 23_400, 600)).toBe(2);
  });

  test("an uncapped cgroup falls back to the box", () => {
    expect(deriveMaxInFlight(c, 3891, null)).toBe(5);
    expect(deriveMaxInFlight(c, 3891, 0)).toBe(5); // 0 = no ceiling read
  });

  // The relationship the unit file documents: ~150M for Bifrost plus
  // maxInFlightCap x perJobMb must fit inside MemoryMax. Now derived, not hoped.
  test("the derived concurrency always fits inside the ceiling", () => {
    for (const ceiling of [512, 1024, 2048, 4096, 8192]) {
      for (const perJobMb of [128, 250, 400]) {
        const n = deriveMaxInFlight(cfg({ perJobMb, maxInFlightCap: 99 }), 23_400, ceiling);
        // one job may exceed a tiny ceiling (floor of 1); beyond that it must fit
        if (n > 1) expect(n * perJobMb).toBeLessThanOrEqual(ceiling);
      }
    }
  });
});

describe("extractConversation", () => {
  test("keeps typed prompts and assistant text, skips wrappers and tool noise", async () => {
    const path = join(tempDir("bifrost-x-"), "t.jsonl");
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
    const path = join(tempDir("bifrost-y-"), "t.jsonl");
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
    const c = cfg({ cacheDir: tempDir("bifrost-q-") });
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
    const c = cfg({ cacheDir: tempDir("bifrost-q2-") });
    const p1 = summarizeSession(c, "same");
    const p2 = summarizeSession(c, "same");
    await Bun.sleep(1);
    expect(started.filter((s) => s === "same").length).toBe(1);
    finish("same");
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
  });

  test("holds the queue when memory is below the reserve, resumes when freed", async () => {
    const c = cfg({ cacheDir: tempDir("bifrost-q3-") });
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
      cacheDir: tempDir("bifrost-q4-"),
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
