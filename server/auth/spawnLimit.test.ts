import { afterEach, describe, expect, test } from "bun:test";
import {
  SPAWN_MAX_PER_WINDOW,
  SPAWN_WINDOW_MS,
  _clear,
  recordSpawn,
  spawnLimited,
} from "./spawnLimit";

afterEach(() => _clear());

describe("spawnLimit — per-key sliding window", () => {
  test("allows up to the cap, blocks the next within the window", () => {
    const ip = "1.2.3.4";
    for (let i = 0; i < SPAWN_MAX_PER_WINDOW; i++) {
      expect(spawnLimited(ip, 1000)).toBe(false);
      recordSpawn(ip, 1000);
    }
    expect(spawnLimited(ip, 1000)).toBe(true);
  });

  test("the window slides — old hits age out", () => {
    const ip = "1.2.3.4";
    for (let i = 0; i < SPAWN_MAX_PER_WINDOW; i++) recordSpawn(ip, 1000);
    expect(spawnLimited(ip, 1000)).toBe(true);
    // past the window, the earlier hits no longer count
    expect(spawnLimited(ip, 1000 + SPAWN_WINDOW_MS + 1)).toBe(false);
  });

  test("keys are independent", () => {
    for (let i = 0; i < SPAWN_MAX_PER_WINDOW; i++) recordSpawn("a", 1000);
    expect(spawnLimited("a", 1000)).toBe(true);
    expect(spawnLimited("b", 1000)).toBe(false);
  });
});
