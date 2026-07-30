import { describe, expect, test } from "bun:test";
import type { IndexEntry } from "../collectors/sessionIndex";
import { needsPinRescue, pinnedToRescue } from "./pinBypass";

function entry(id: string, mtimeMs: number): IndexEntry {
  return {
    sessionId: id,
    path: `/x/${id}.jsonl`,
    slug: "x",
    mtimeMs,
    size: 10,
    cwd: "/home/you/proj",
    name: "proj",
  };
}

describe("needsPinRescue (AC2.3 predicate)", () => {
  const pinned = new Set(["a", "b"]);

  test("pinned + absent from the bounded list → rescue", () => {
    expect(needsPinRescue("a", pinned, new Set())).toBe(true);
  });

  test("pinned but already in the bounded list → no rescue (no duplicate)", () => {
    expect(needsPinRescue("a", pinned, new Set(["a"]))).toBe(false);
  });

  test("not pinned → never rescued, however absent", () => {
    expect(needsPinRescue("z", pinned, new Set())).toBe(false);
  });
});

describe("pinnedToRescue (bypass BOTH cutoffs)", () => {
  test("a pinned session older than historyDays is rescued from the uncapped index", () => {
    // `old` is years past any historyDays cutoff and was never in the bounded
    // list — pin must still surface it. The predicate consults no cutoff at all.
    const index = [entry("old", 1), entry("recent", 9_000)];
    const rescued = pinnedToRescue(
      index,
      new Set(["old"]),
      new Set(["recent"]), // bounded list = only the recent one
      new Set(),
    );
    expect(rescued.map((e) => e.sessionId)).toEqual(["old"]);
  });

  test("a pinned session sliced off beyond maxHistory is rescued", () => {
    // `overcap` is recent (would pass historyDays) but the maxHistory slice
    // dropped it from the bounded list. Pin bypasses the slice too.
    const index = [entry("overcap", 8_000), entry("shown", 9_000)];
    const rescued = pinnedToRescue(
      index,
      new Set(["overcap"]),
      new Set(["shown"]),
      new Set(),
    );
    expect(rescued.map((e) => e.sessionId)).toEqual(["overcap"]);
  });

  test("a pinned session already shown is not duplicated", () => {
    const index = [entry("a", 5)];
    expect(
      pinnedToRescue(index, new Set(["a"]), new Set(["a"]), new Set()),
    ).toEqual([]);
  });

  test("a pinned LIVE session is never rescued (it always renders)", () => {
    const index = [entry("live1", 5)];
    expect(
      pinnedToRescue(index, new Set(["live1"]), new Set(), new Set(["live1"])),
    ).toEqual([]);
  });

  test("unpinned dropped sessions stay dropped", () => {
    const index = [entry("a", 5), entry("b", 6)];
    expect(pinnedToRescue(index, new Set(), new Set(), new Set())).toEqual([]);
  });

  test("multiple rescues come back newest-first", () => {
    const index = [entry("x", 100), entry("y", 300), entry("z", 200)];
    const rescued = pinnedToRescue(
      index,
      new Set(["x", "y", "z"]),
      new Set(),
      new Set(),
    );
    expect(rescued.map((e) => e.sessionId)).toEqual(["y", "z", "x"]);
  });
});
