import { describe, expect, test } from "bun:test";
import { windowMessages } from "./messageWindow";

const seq = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("windowMessages — tail-windowing the drive transcript", () => {
  test("under the limit: everything visible, nothing hidden", () => {
    const r = windowMessages(seq(10), 120, false);
    expect(r.hiddenCount).toBe(0);
    expect(r.visible.length).toBe(10);
  });

  test("at the limit exactly: still all visible", () => {
    const r = windowMessages(seq(120), 120, false);
    expect(r.hiddenCount).toBe(0);
    expect(r.visible.length).toBe(120);
  });

  test("over the limit: only the last `limit` render, rest counted hidden", () => {
    const r = windowMessages(seq(200), 120, false);
    expect(r.hiddenCount).toBe(80);
    expect(r.visible.length).toBe(120);
    expect(r.visible[0]).toBe(80); // the tail, in order
    expect(r.visible[r.visible.length - 1]).toBe(199);
  });

  test("expanded: everything visible even far over the limit", () => {
    const r = windowMessages(seq(500), 120, true);
    expect(r.hiddenCount).toBe(0);
    expect(r.visible.length).toBe(500);
  });

  test("empty transcript is a clean no-op", () => {
    const r = windowMessages([], 120, false);
    expect(r.visible).toEqual([]);
    expect(r.hiddenCount).toBe(0);
  });
});
