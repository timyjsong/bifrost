import { describe, expect, test } from "bun:test";
import { clean } from "./settings";

describe("settings.clean — clamp/validate the send grace period", () => {
  test("a sane value passes through", () => {
    expect(clean({ sendDelayMs: 3000 })).toEqual({ sendDelayMs: 3000, defaultModel: "opus" });
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

describe("settings.clean — default model for new sessions", () => {
  test("a valid alias passes through", () => {
    expect(clean({ defaultModel: "haiku" }).defaultModel).toBe("haiku");
    expect(clean({ defaultModel: "fable" }).defaultModel).toBe("fable");
  });

  test("an unknown / missing / corrupt value falls back to opus", () => {
    expect(clean({ defaultModel: "gpt-5" as never }).defaultModel).toBe("opus");
    expect(clean({}).defaultModel).toBe("opus");
    expect(clean(null).defaultModel).toBe("opus");
    expect(clean({ defaultModel: 42 as never }).defaultModel).toBe("opus");
  });

  test("cleaning one field never drops the other", () => {
    const out = clean({ defaultModel: "sonnet" });
    expect(out.sendDelayMs).toBe(3000);
    expect(clean({ sendDelayMs: 1000 }).defaultModel).toBe("opus");
  });
});
