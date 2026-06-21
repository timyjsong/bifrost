import { describe, expect, test } from "bun:test";
import { clean } from "./settings";

describe("settings.clean — clamp/validate the send grace period", () => {
  test("a sane value passes through", () => {
    expect(clean({ sendDelayMs: 3000 })).toEqual({ sendDelayMs: 3000 });
  });

  test("negative clamps to 0 (send-now)", () => {
    expect(clean({ sendDelayMs: -5000 }).sendDelayMs).toBe(0);
  });

  test("above the 30s ceiling clamps down", () => {
    expect(clean({ sendDelayMs: 999_999 }).sendDelayMs).toBe(30_000);
  });

  test("fractional ms is rounded", () => {
    expect(clean({ sendDelayMs: 2500.7 }).sendDelayMs).toBe(2501);
  });

  test("a non-finite / missing / corrupt value falls back to the default", () => {
    expect(clean({ sendDelayMs: NaN }).sendDelayMs).toBe(3000);
    expect(clean({}).sendDelayMs).toBe(3000);
    expect(clean(null).sendDelayMs).toBe(3000);
    expect(clean(undefined).sendDelayMs).toBe(3000);
  });

  test("a string number is coerced then clamped", () => {
    expect(clean({ sendDelayMs: "5000" as unknown as number }).sendDelayMs).toBe(5000);
  });
});
