import { describe, expect, test } from "bun:test";
import { staleLabel, streamQuiet } from "./staleness";

describe("streamQuiet — hung-stream detection", () => {
  test("activity inside the window is not quiet", () => {
    expect(streamQuiet(1000, 1000 + 14_999, 15_000)).toBe(false);
  });

  test("silence at/past the threshold is quiet", () => {
    expect(streamQuiet(1000, 1000 + 15_000, 15_000)).toBe(true);
    expect(streamQuiet(1000, 1000 + 60_000, 15_000)).toBe(true);
  });
});

describe("staleLabel — how old the on-screen data is", () => {
  test("seconds under a minute", () => {
    expect(staleLabel(10_000, 52_000)).toBe("stale 42s");
  });

  test("minutes under an hour", () => {
    expect(staleLabel(1_000, 1_000 + 3 * 60_000 + 5_000)).toBe("stale 3m");
  });

  test("hours beyond that", () => {
    expect(staleLabel(1_000, 1_000 + 2 * 3_600_000 + 60_000)).toBe("stale 2h");
  });

  test("no timestamp still yields a usable label", () => {
    expect(staleLabel(undefined, 1000)).toBe("stale");
  });

  test("a future timestamp clamps to zero, never negative", () => {
    expect(staleLabel(5000, 1000)).toBe("stale 0s");
  });
});
