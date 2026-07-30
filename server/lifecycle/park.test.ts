import { describe, expect, test } from "bun:test";
import { capKills, decidePark, type ParkSignals } from "./park";

const NOW = 1_000_000_000;
const DAY = 24 * 3_600_000;
const idle: ParkSignals = {
  live: true,
  bifrostSpawned: true,
  state: "awaiting",
  working: false,
  lastActivityAt: NOW - DAY - 1,
  childProcs: 0,
  hasInflightJob: false,
  hasQueuedOp: false,
};
const CFG = { idleParkMs: DAY, enabled: true };

// ── §3 — ALL four conditions must hold ──────────────────────────────────────────
describe("decidePark — the multi-signal idle gate", () => {
  test("a truly idle bifrost-spawned session parks with mode kill when armed", () => {
    expect(decidePark(idle, NOW, CFG)).toEqual({ park: true, mode: "kill" });
  });

  test("each blocking condition alone prevents the park", () => {
    const cases: [Partial<ParkSignals>, string][] = [
      [{ working: true }, "working"],
      [{ state: "working" }, "state:working"],
      [{ state: "approval" }, "state:approval"],
      [{ childProcs: 2 }, "children"],
      [{ hasInflightJob: true }, "inflight-job"],
      [{ hasQueuedOp: true }, "queued-op"], // load-bearing: queued input DIES on park (phase-1 Test B)
      [{ lastActivityAt: NOW - DAY + 1000 }, "not-idle-long-enough"],
      [{ live: false }, "not-live"],
    ];
    for (const [patch, reason] of cases) {
      expect(decidePark({ ...idle, ...patch }, NOW, CFG)).toEqual({ park: false, reason });
    }
  });

  test("disabled (Phase 0) demotes an eligible kill to observe — never silent-skips", () => {
    expect(decidePark(idle, NOW, { ...CFG, enabled: false })).toEqual({
      park: true,
      mode: "observe",
    });
  });

  test("a non-Bifrost session is observe-only even when armed (blast-radius guard)", () => {
    expect(decidePark({ ...idle, bifrostSpawned: false }, NOW, CFG)).toEqual({
      park: true,
      mode: "observe",
    });
  });
});

// ── §8 — max-kills-per-sweep cap ────────────────────────────────────────────────
describe("capKills", () => {
  test("kills beyond the cap demote to observe; observes pass through", () => {
    const items = [
      { id: "a", verdict: { park: true, mode: "kill" } as const },
      { id: "b", verdict: { park: true, mode: "observe" } as const },
      { id: "c", verdict: { park: true, mode: "kill" } as const },
      { id: "d", verdict: { park: true, mode: "kill" } as const },
    ];
    const capped = capKills(items, 2);
    expect(capped.map((i) => (i.verdict.park ? i.verdict.mode : "no"))).toEqual([
      "kill",
      "observe",
      "kill",
      "observe",
    ]);
  });
});
