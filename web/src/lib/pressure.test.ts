import { describe, expect, test } from "bun:test";
import { pressureHue } from "./pressure";

describe("pressureHue", () => {
  test("anchors: green at 0, orange at 50%, red at 100%", () => {
    expect(pressureHue(0)).toBe(140);
    expect(pressureHue(0.5)).toBe(38);
    expect(pressureHue(1)).toBe(0);
  });
  test("monotonically decreasing (never gets greener under more pressure)", () => {
    let prev = pressureHue(0);
    for (let r = 0.05; r <= 1; r += 0.05) {
      const h = pressureHue(r);
      expect(h).toBeLessThanOrEqual(prev);
      prev = h;
    }
  });
  test("clamps out-of-range input", () => {
    expect(pressureHue(-5)).toBe(140);
    expect(pressureHue(99)).toBe(0);
  });
});
