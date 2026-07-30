import { describe, expect, test } from "bun:test";
import { summarizePark } from "./park";
import type { ParkLogEntry } from "../../../shared/types";

const e = (uuid: string, mode: "kill" | "observe"): ParkLogEntry => ({
  at: 1,
  uuid,
  mode,
  cwd: "/x",
  idleMs: 100,
});

describe("summarizePark — the arming-readiness roll-up", () => {
  test("counts observe vs kill and distinct sessions", () => {
    const s = summarizePark([e("a", "observe"), e("b", "kill"), e("a", "observe")]);
    expect(s).toEqual({ observeCount: 2, killCount: 1, sessionCount: 2 });
  });

  test("empty log is all zeros", () => {
    expect(summarizePark([])).toEqual({ observeCount: 0, killCount: 0, sessionCount: 0 });
  });

  test("a clean observe-only history: zero kills is the safe-to-arm signal", () => {
    const s = summarizePark([e("a", "observe"), e("b", "observe")]);
    expect(s.killCount).toBe(0);
    expect(s.observeCount).toBe(2);
  });
});
