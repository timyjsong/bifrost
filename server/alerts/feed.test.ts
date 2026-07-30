import { describe, expect, test } from "bun:test";
import { pushRecent } from "./feed";
import type { RecentAlert } from "../../shared/alerts";

const mk = (title: string, firedAt: number): RecentAlert => ({
  id: "session_done",
  tier: 2,
  severity: "info",
  title,
  body: title,
  firedAt,
});

describe("pushRecent — bounded recent-alerts ring", () => {
  test("empty incoming leaves the buffer untouched", () => {
    const buf = [mk("a", 1)];
    expect(pushRecent(buf, [], 10)).toBe(buf);
  });

  test("prepends this tick's alerts newest-first", () => {
    const buf = [mk("old", 1)];
    const out = pushRecent(buf, [mk("new1", 2), mk("new2", 2)], 10);
    expect(out.map((a) => a.title)).toEqual(["new1", "new2", "old"]);
  });

  test("caps the log, dropping the oldest", () => {
    let buf: RecentAlert[] = [];
    for (let i = 0; i < 5; i++) buf = pushRecent(buf, [mk(`n${i}`, i)], 3);
    expect(buf.map((a) => a.title)).toEqual(["n4", "n3", "n2"]);
    expect(buf.length).toBe(3);
  });

  test("a multi-alert tick that overflows still caps", () => {
    const out = pushRecent([mk("keep", 0)], [mk("x", 1), mk("y", 1), mk("z", 1)], 2);
    expect(out.map((a) => a.title)).toEqual(["x", "y"]);
  });

  test("cap 0 empties the log", () => {
    expect(pushRecent([mk("a", 1)], [mk("b", 2)], 0)).toEqual([]);
  });
});
