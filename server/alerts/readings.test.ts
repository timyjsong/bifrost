import { describe, expect, test } from "bun:test";
import { defaultPolicy } from "../../shared/alerts";
import type { SessionInfo, SystemInfo } from "../../shared/types";
import type { AlertSources } from "./sources";
import { deriveReadings, emptyDeriveState, type DeriveState } from "./readings";
import { evaluate, type EngineState } from "./engine";

const sources = (over: Partial<AlertSources> = {}): AlertSources => ({
  oomKill: 0,
  ramWall: 0,
  swapPct: 0,
  swapCurrentKb: 0,
  psiMemSome: 0,
  servicesDown: [],
  limitsHealthy: true,
  ...over,
});

const system = (over: Partial<SystemInfo> = {}): SystemInfo => ({
  hostname: "dev",
  uptimeSec: 10_000,
  load: [1, 1, 1],
  disk: { totalKb: 1_000_000, freeKb: 500_000 },
  cores: 8,
  mem: { totalKb: 16_000_000, availKb: 8_000_000, swapTotalKb: 0, swapFreeKb: 0 },
  procs: [],
  claudeTotalRssKb: 0,
  tmux: [],
  ports: [],
  ...over,
});

const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: "00000000-0000-0000-0000-000000000001",
  live: true,
  cwd: "/home/you/proj",
  lastActivityAt: 0,
  ...over,
});

const valueOf = (rs: ReturnType<typeof deriveReadings>["readings"], id: string) =>
  rs.find((r) => r.id === id)?.value;
const activeOf = (rs: ReturnType<typeof deriveReadings>["readings"], id: string) =>
  rs.find((r) => r.id === id)?.active;

describe("gauge value math", () => {
  test("cpu_storm is load-per-core, disk_low is free%", () => {
    const { readings } = deriveReadings(
      sources({ swapPct: 42, psiMemSome: 30 }),
      system({ load: [12, 8, 6], cores: 8, disk: { totalKb: 1000, freeKb: 70 } }),
      [],
      defaultPolicy(),
      emptyDeriveState(),
      1_000,
    );
    expect(valueOf(readings, "cpu_storm")).toBeCloseTo(1.5); // 12 / 8
    expect(valueOf(readings, "disk_low")).toBeCloseTo(7); // 70 / 1000 %
    expect(valueOf(readings, "swap_ceiling")).toBe(42);
    expect(valueOf(readings, "mem_stall")).toBe(30);
  });
});

const waitReadings = (rs: ReturnType<typeof deriveReadings>["readings"]) =>
  rs.filter((r) => r.id === "session_waiting");
const waitFor = (rs: ReturnType<typeof deriveReadings>["readings"], id: string) =>
  rs.find((r) => r.id === "session_waiting" && r.instance === id);

describe("session_waiting (per-session)", () => {
  test("one reading per live session, active only once past the threshold", () => {
    const now = 60_000 * 30;
    const sessions = [
      session({ sessionId: "a", state: "working", lastActivityAt: now - 60_000 * 20 }),
      session({ sessionId: "b", state: "awaiting", lastActivityAt: now - 60_000 * 15 }), // 15 ≥ 10
      session({ sessionId: "c", state: "approval", lastActivityAt: now - 60_000 * 8 }), //  8 < 10
    ];
    const { readings } = deriveReadings(
      sources(),
      system(),
      sessions,
      defaultPolicy(),
      emptyDeriveState(),
      now,
    );
    expect(waitReadings(readings).map((r) => r.instance).sort()).toEqual(["a", "b", "c"]);
    expect(waitFor(readings, "a")?.active).toBe(false); // working
    expect(waitFor(readings, "b")?.active).toBe(true); // awaiting 15m
    expect(waitFor(readings, "c")?.active).toBe(false); // approval 8m
  });
});

describe("session_waiting fires once per episode (derive → engine)", () => {
  const MIN = 60_000;
  const policy = defaultPolicy(); // threshold 10m, cooldown 600s
  const awaiting = (sid: string, agoMin: number, now: number) =>
    session({ sessionId: sid, state: "awaiting", lastActivityAt: now - agoMin * MIN });
  const working = (sid: string, now: number) =>
    session({ sessionId: sid, state: "working", lastActivityAt: now });

  function step(
    sessions: SessionInfo[],
    es: EngineState,
    ds: DeriveState,
    now: number,
  ) {
    const d = deriveReadings(sources(), system(), sessions, policy, ds, now);
    const e = evaluate(d.readings, policy, es, now);
    return { fired: e.fired.map((f) => f.tag), es: e.next, ds: d.next };
  }

  test("fires once on crossing, stays quiet while waiting, re-fires a fresh episode", () => {
    let es: EngineState = {};
    let ds = emptyDeriveState();

    // working → baseline, no fire
    let r = step([working("s1", 0)], es, ds, 0);
    (es = r.es), (ds = r.ds);
    expect(r.fired).toEqual([]);

    // crosses 10m of waiting → one alert
    r = step([awaiting("s1", 11, 11 * MIN)], es, ds, 11 * MIN);
    (es = r.es), (ds = r.ds);
    expect(r.fired).toEqual(["session_waiting:s1"]);

    // still waiting → no re-nag
    for (const m of [12, 15, 20]) {
      r = step([awaiting("s1", m, m * MIN)], es, ds, m * MIN);
      (es = r.es), (ds = r.ds);
      expect(r.fired).toEqual([]);
    }

    // responded (working) → re-arm, no fire
    r = step([working("s1", 25 * MIN)], es, ds, 25 * MIN);
    (es = r.es), (ds = r.ds);
    expect(r.fired).toEqual([]);

    // waits again → fresh episode → fires again
    r = step([awaiting("s1", 11, 40 * MIN)], es, ds, 40 * MIN);
    expect(r.fired).toEqual(["session_waiting:s1"]);
  });

  test("two waiting sessions are two independent alerts", () => {
    let es: EngineState = {};
    let ds = emptyDeriveState();
    let r = step([working("a", 0), working("b", 0)], es, ds, 0);
    (es = r.es), (ds = r.ds);
    r = step([awaiting("a", 11, 11 * MIN), awaiting("b", 11, 11 * MIN)], es, ds, 11 * MIN);
    expect(r.fired.sort()).toEqual(["session_waiting:a", "session_waiting:b"]);
  });
});

describe("box_changed (transition)", () => {
  test("no prior baseline never flags", () => {
    const { readings } = deriveReadings(sources(), system(), [], defaultPolicy(), emptyDeriveState(), 1_000);
    expect(activeOf(readings, "box_changed")).toBe(false);
  });

  test("uptime dropping flags a reboot; total RAM changing flags a resize", () => {
    const prev: DeriveState = { prevUptimeSec: 9_999, prevMemTotalKb: 16_000_000, working: {} };
    const reboot = deriveReadings(sources(), system({ uptimeSec: 30 }), [], defaultPolicy(), prev, 1_000);
    expect(activeOf(reboot.readings, "box_changed")).toBe(true);

    const resize = deriveReadings(
      sources(),
      system({ uptimeSec: 10_001, mem: { totalKb: 32_000_000, availKb: 1, swapTotalKb: 0, swapFreeKb: 0 } }),
      [],
      defaultPolicy(),
      prev,
      1_000,
    );
    expect(activeOf(resize.readings, "box_changed")).toBe(true);
  });
});

describe("long_run_done (transition)", () => {
  test("flags a finished run only once it exceeds the threshold", () => {
    const policy = defaultPolicy(); // long_run_done threshold 30 min
    const id = "long-run";
    // working since t0
    const t0 = 1_000;
    let st = deriveReadings(
      sources(),
      system(),
      [session({ sessionId: id, state: "working", lastActivityAt: t0 })],
      policy,
      emptyDeriveState(),
      t0,
    ).next;
    // 40 min later it goes to awaiting → fired (40 ≥ 30)
    const t1 = t0 + 60_000 * 40;
    const done = deriveReadings(
      sources(),
      system(),
      [session({ sessionId: id, state: "awaiting", lastActivityAt: t1 })],
      policy,
      st,
      t1,
    );
    expect(activeOf(done.readings, "long_run_done")).toBe(true);
  });

  test("a short run finishing does not flag", () => {
    const policy = defaultPolicy();
    const id = "short-run";
    const t0 = 1_000;
    const st = deriveReadings(
      sources(),
      system(),
      [session({ sessionId: id, state: "working", lastActivityAt: t0 })],
      policy,
      emptyDeriveState(),
      t0,
    ).next;
    const t1 = t0 + 60_000 * 10; // 10 min < 30
    const done = deriveReadings(
      sources(),
      system(),
      [session({ sessionId: id, state: "awaiting", lastActivityAt: t1 })],
      policy,
      st,
      t1,
    );
    expect(activeOf(done.readings, "long_run_done")).toBe(false);
  });
});

describe("transition flags from sources", () => {
  test("service_down and safeguard_health reflect the sources", () => {
    const { readings } = deriveReadings(
      sources({ servicesDown: ["ssh"], limitsHealthy: false, limitsReason: "timer dead" }),
      system(),
      [],
      defaultPolicy(),
      emptyDeriveState(),
      1_000,
    );
    expect(activeOf(readings, "service_down")).toBe(true);
    expect(activeOf(readings, "safeguard_health")).toBe(true);
  });
});
