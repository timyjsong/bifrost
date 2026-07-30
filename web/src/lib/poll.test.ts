import { describe, expect, test } from "bun:test";
import { startGuardedPoll } from "./poll";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("startGuardedPoll — no overlapping requests", () => {
  test("a slow tick never overlaps itself (max concurrency 1)", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    let ticks = 0;
    const stop = startGuardedPoll(async () => {
      inFlight++;
      ticks++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await sleep(40); // tick slower than the interval
      inFlight--;
    }, 5);
    await sleep(250);
    stop();
    expect(maxConcurrent).toBe(1); // the guard held — never two at once
    expect(ticks).toBeGreaterThan(1); // it did keep polling
  });

  test("a thrown tick doesn't kill the loop", async () => {
    let ticks = 0;
    const stop = startGuardedPoll(async () => {
      ticks++;
      throw new Error("boom");
    }, 5);
    await sleep(60);
    stop();
    expect(ticks).toBeGreaterThan(2); // kept going despite throwing every time
  });

  test("stop() halts scheduling", async () => {
    let ticks = 0;
    const stop = startGuardedPoll(async () => {
      ticks++;
    }, 5);
    await sleep(30);
    stop();
    const after = ticks;
    await sleep(40);
    expect(ticks).toBe(after); // no further ticks after stop
  });
});
