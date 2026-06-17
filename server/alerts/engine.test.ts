import { describe, expect, test } from "bun:test";
import { defaultPolicy, type AlertPolicy } from "../../shared/alerts";
import { evaluate, type EngineState, type SignalReading } from "./engine";

/** Drive a sequence of single-signal readings through the engine, collecting fires. */
function run(
  steps: Array<{ now: number; reading: SignalReading }>,
  policy: AlertPolicy = defaultPolicy(),
) {
  let state: EngineState = {};
  const fires: Array<{ at: number; ids: string[] }> = [];
  for (const { now, reading } of steps) {
    const { fired, next } = evaluate([reading], policy, state, now);
    state = next;
    fires.push({ at: now, ids: fired.map((f) => f.id) });
  }
  return fires;
}

describe("edge signals (oom_shed)", () => {
  test("first observation never fires; a rising counter does", () => {
    const fires = run([
      { now: 0, reading: { id: "oom_shed", counter: 0 } },
      { now: 1_000, reading: { id: "oom_shed", counter: 0 } },
      { now: 2_000, reading: { id: "oom_shed", counter: 1 } },
    ]);
    expect(fires[0].ids).toEqual([]); // baseline
    expect(fires[1].ids).toEqual([]); // unchanged
    expect(fires[2].ids).toEqual(["oom_shed"]); // ++ → fire
  });

  test("cooldown suppresses a second edge inside the window, allows it after", () => {
    // oom_shed default cooldown = 60s
    const fires = run([
      { now: 0, reading: { id: "oom_shed", counter: 0 } },
      { now: 1_000, reading: { id: "oom_shed", counter: 1 } }, // fire
      { now: 30_000, reading: { id: "oom_shed", counter: 2 } }, // within cooldown
      { now: 70_000, reading: { id: "oom_shed", counter: 3 } }, // past cooldown
    ]);
    expect(fires[1].ids).toEqual(["oom_shed"]);
    expect(fires[2].ids).toEqual([]);
    expect(fires[3].ids).toEqual(["oom_shed"]);
  });
});

describe("gauge signals", () => {
  test("swap_ceiling (sustain 0) fires on first crossing", () => {
    const fires = run([
      { now: 0, reading: { id: "swap_ceiling", value: 50 } }, // below 70
      { now: 3_000, reading: { id: "swap_ceiling", value: 80 } }, // cross
    ]);
    expect(fires[0].ids).toEqual([]);
    expect(fires[1].ids).toEqual(["swap_ceiling"]);
  });

  test("mem_stall holds past the sustain window before firing", () => {
    // mem_stall threshold 40, sustainSec 6
    const fires = run([
      { now: 0, reading: { id: "mem_stall", value: 60 } }, // crosses, sustain starts
      { now: 3_000, reading: { id: "mem_stall", value: 60 } }, // 3s < 6s
      { now: 6_000, reading: { id: "mem_stall", value: 60 } }, // 6s ≥ 6s → fire
    ]);
    expect(fires[0].ids).toEqual([]);
    expect(fires[1].ids).toEqual([]);
    expect(fires[2].ids).toEqual(["mem_stall"]);
  });

  test("a dip below the hysteresis floor resets the sustain timer", () => {
    // threshold 40, clear floor = 40 * 0.85 = 34
    const fires = run([
      { now: 0, reading: { id: "mem_stall", value: 60 } }, // sustain starts
      { now: 3_000, reading: { id: "mem_stall", value: 30 } }, // < 34 → reset
      { now: 6_000, reading: { id: "mem_stall", value: 60 } }, // sustain restarts
      { now: 9_000, reading: { id: "mem_stall", value: 60 } }, // only 3s sustained
    ]);
    expect(fires.every((f) => f.ids.length === 0)).toBe(true);
  });

  test("inverted gauge (disk_low) fires when value drops below the threshold", () => {
    // disk_low threshold 10 (% free), invert
    const fires = run([
      { now: 0, reading: { id: "disk_low", value: 25 } }, // healthy
      { now: 3_000, reading: { id: "disk_low", value: 6 } }, // < 10 → fire
    ]);
    expect(fires[0].ids).toEqual([]);
    expect(fires[1].ids).toEqual(["disk_low"]);
  });
});

describe("rate signals (swap_fill)", () => {
  test("fires when the per-minute rise meets the threshold", () => {
    // swap_fill threshold 15 %/min
    const fires = run([
      { now: 0, reading: { id: "swap_fill", value: 10 } }, // first sample
      { now: 60_000, reading: { id: "swap_fill", value: 30 } }, // +20/min ≥ 15
    ]);
    expect(fires[0].ids).toEqual([]);
    expect(fires[1].ids).toEqual(["swap_fill"]);
  });

  test("a gentle rise below the threshold does not fire", () => {
    const fires = run([
      { now: 0, reading: { id: "swap_fill", value: 10 } },
      { now: 60_000, reading: { id: "swap_fill", value: 18 } }, // +8/min < 15
    ]);
    expect(fires[1].ids).toEqual([]);
  });
});

describe("transition signals (service_down)", () => {
  test("first observation can't fire; entering the bad state does", () => {
    const fires = run([
      { now: 0, reading: { id: "service_down", active: true } }, // unknown prior → baseline
      { now: 1_000, reading: { id: "service_down", active: false } },
      { now: 2_000, reading: { id: "service_down", active: true } }, // false→true → fire
      { now: 3_000, reading: { id: "service_down", active: true } }, // still bad → no
    ]);
    expect(fires[0].ids).toEqual([]);
    expect(fires[2].ids).toEqual(["service_down"]);
    expect(fires[3].ids).toEqual([]);
  });
});

describe("policy gating", () => {
  test("a disabled signal never fires", () => {
    const policy = defaultPolicy();
    policy.signals.oom_shed.enabled = false;
    const fires = run(
      [
        { now: 0, reading: { id: "oom_shed", counter: 0 } },
        { now: 1_000, reading: { id: "oom_shed", counter: 5 } },
      ],
      policy,
    );
    expect(fires.every((f) => f.ids.length === 0)).toBe(true);
  });

  test("re-enabling after a jump does not false-fire on the stale edge", () => {
    const policy = defaultPolicy();
    policy.signals.oom_shed.enabled = false;
    let state: EngineState = {};
    // disabled period: counter climbs 0 → 9, baseline tracks it
    for (const c of [0, 3, 9]) {
      state = evaluate([{ id: "oom_shed", counter: c }], policy, state, c).next;
    }
    policy.signals.oom_shed.enabled = true;
    // first enabled tick at the same counter: no jump → no fire
    const r1 = evaluate([{ id: "oom_shed", counter: 9 }], policy, state, 100);
    expect(r1.fired).toEqual([]);
    // a genuine new edge fires
    const r2 = evaluate([{ id: "oom_shed", counter: 10 }], policy, r1.next, 200);
    expect(r2.fired.map((f) => f.id)).toEqual(["oom_shed"]);
  });

  test("cooldowns are independent per signal", () => {
    const fires = run([
      { now: 0, reading: { id: "oom_shed", counter: 0 } },
      { now: 1_000, reading: { id: "oom_shed", counter: 1 } }, // oom fires
      { now: 1_000, reading: { id: "ram_wall", counter: 0 } }, // ram baseline
      { now: 2_000, reading: { id: "ram_wall", counter: 1 } }, // ram fires despite oom cooldown
    ]);
    expect(fires[1].ids).toEqual(["oom_shed"]);
    expect(fires[3].ids).toEqual(["ram_wall"]);
  });
});

describe("composed alert shape", () => {
  test("carries tier/severity, uses context as the body, tag = id", () => {
    const { fired } = evaluate(
      [{ id: "oom_shed", counter: 1, context: "atlas-web (pid 1234) was killed" }],
      defaultPolicy(),
      { oom_shed: { prevCounter: 0 } },
      1_000,
    );
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      id: "oom_shed",
      tier: 0,
      severity: "crit",
      title: "OOM kill",
      body: "atlas-web (pid 1234) was killed",
      tag: "oom_shed",
    });
  });
});

describe("per-instance alerts carry the instance (deep-link, M8)", () => {
  test("a session-scoped fire reports its session id on the FiredAlert", () => {
    let state: EngineState = {};
    // transition: arm inactive, then fire on the active edge
    let out = evaluate(
      [{ id: "session_approval", instance: "sess-123", active: false }],
      defaultPolicy(),
      state,
      0,
    );
    state = out.next;
    out = evaluate(
      [{ id: "session_approval", instance: "sess-123", active: true }],
      defaultPolicy(),
      state,
      1_000,
    );
    const fire = out.fired.find((f) => f.id === "session_approval");
    expect(fire).toBeDefined();
    expect(fire!.instance).toBe("sess-123"); // → /?session=sess-123 deep link
    expect(fire!.tag).toBe("session_approval:sess-123");
  });
});
