import { describe, expect, test } from "bun:test";
import { groupSessions, splitColumns, queueStatusOf } from "./selectors";
import type { SessionInfo } from "../../../shared/types";

const s = (over: Partial<SessionInfo>): SessionInfo => ({
  sessionId: Math.random().toString(36).slice(2),
  live: true,
  cwd: "/x",
  lastActivityAt: 100,
  ...over,
});

describe("groupSessions", () => {
  test("partitions and orders needs-you longest-wait-first", () => {
    const a = s({ state: "awaiting", lastActivityAt: 300 });
    const b = s({ state: "awaiting", lastActivityAt: 100 }); // waited longest
    const c = s({ state: "working" });
    const d = s({ state: "paused" });
    const e = s({ live: true, headless: true });
    const f = s({ live: false }); // dead history is not displayed
    const groups = groupSessions([a, b, c, d, e, f]);
    expect(groups.needsYou.map((x) => x.sessionId)).toEqual([
      b.sessionId,
      a.sessionId,
    ]);
    expect(groups.working).toEqual([c, d]);
    expect(groups.liveHeadless).toEqual([e]);
  });
  test("approval counts as needs-you", () => {
    const groups = groupSessions([s({ state: "approval" })]);
    expect(groups.needsYou.length).toBe(1);
  });
});

describe("splitColumns", () => {
  test("round-robins across columns", () => {
    expect(splitColumns([1, 2, 3, 4, 5], 2)).toEqual([
      [1, 3, 5],
      [2, 4],
    ]);
  });
  test("single column passes through", () => {
    expect(splitColumns([1, 2], 1)).toEqual([[1, 2]]);
  });
});

describe("queueStatusOf", () => {
  const sum = { active: ["a"], queued: ["q"] };
  test("classifies", () => {
    expect(queueStatusOf("a", sum)).toBe("active");
    expect(queueStatusOf("q", sum)).toBe("queued");
    expect(queueStatusOf("z", sum)).toBeUndefined();
    expect(queueStatusOf("a", undefined)).toBeUndefined();
  });
});
