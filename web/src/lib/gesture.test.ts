import { describe, expect, test } from "bun:test";
import {
  isHorizontalBack,
  isCommitted,
  clampDrag,
  shouldComplete,
  isNearBottom,
} from "./gesture";

describe("isHorizontalBack — rightward and mostly horizontal", () => {
  test("rightward + more horizontal than vertical → yes", () => {
    expect(isHorizontalBack(40, 10)).toBe(true);
  });
  test("leftward → no (that's not back)", () => {
    expect(isHorizontalBack(-40, 5)).toBe(false);
  });
  test("mostly vertical → no (let it scroll)", () => {
    expect(isHorizontalBack(10, 40)).toBe(false);
  });
});

describe("isCommitted — direction decided after enough movement", () => {
  test("tiny jitter is not committed; 8px+ in either axis is", () => {
    expect(isCommitted(3, 4)).toBe(false);
    expect(isCommitted(8, 0)).toBe(true);
    expect(isCommitted(0, 9)).toBe(true);
  });
});

describe("clampDrag — bounded to [0, width]", () => {
  test("clamps negatives to 0 and overshoot to width", () => {
    expect(clampDrag(-20, 400)).toBe(0);
    expect(clampDrag(150, 400)).toBe(150);
    expect(clampDrag(999, 400)).toBe(400);
  });
});

describe("shouldComplete — release past 35% of width", () => {
  test("past the threshold completes; short snaps back", () => {
    expect(shouldComplete(140, 400)).toBe(true); // 35%
    expect(shouldComplete(139, 400)).toBe(false);
    expect(shouldComplete(0, 400)).toBe(false);
    expect(shouldComplete(100, 0)).toBe(false); // guard against zero width
  });
});

describe("isNearBottom — stick-only-when-near-bottom", () => {
  test("at the bottom is near", () => {
    expect(isNearBottom(880, 1000, 120)).toBe(true); // 1000-(880+120)=0
  });
  test("within the threshold is near", () => {
    expect(isNearBottom(800, 1000, 120)).toBe(true); // gap 80 <= 120
  });
  test("scrolled up past the threshold is NOT near (don't steal scroll)", () => {
    expect(isNearBottom(200, 1000, 120)).toBe(false); // gap 680
  });
})
