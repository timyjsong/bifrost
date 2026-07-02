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

const inst = (
  rs: ReturnType<typeof deriveReadings>["readings"],
  id: string,
  instance: string,
) => rs.find((r) => r.id === id && r.instance === instance);

// a re-attributed agent at 0% CPU: alive but idle — the gate is presence, not CPU
const child = { pid: 1, etime: "05:00", rssKb: 1_000, cpu: 0, command: "claude (agent)" };

describe("session signals — per-session shape + mute", () => {
  test("each live interactive session gets done + reminder + approval readings", () => {
    const now = 60_000 * 30;
    const sessions = [
      session({ sessionId: "a", state: "working", lastActivityAt: now }),
      session({ sessionId: "b", state: "awaiting", lastActivityAt: now - 60_000 * 15 }),
    ];
    const { readings } = deriveReadings(sources(), system(), sessions, defaultPolicy(), emptyDeriveState(), now);
    for (const id of ["session_done", "session_reminder", "session_approval"]) {
      expect(readings.filter((r) => r.id === id).map((r) => r.instance).sort()).toEqual(["a", "b"]);
    }
  });

  test("a muted session (alertsEnabled false) emits no session readings", () => {
    const now = 60_000 * 30;
    const sessions = [
      session({ sessionId: "on", state: "awaiting", lastActivityAt: now - 60_000 * 20 }),
      session({ sessionId: "off", state: "awaiting", lastActivityAt: now - 60_000 * 20, alertsEnabled: false }),
    ];
    const { readings } = deriveReadings(sources(), system(), sessions, defaultPolicy(), emptyDeriveState(), now);
    expect(readings.some((r) => r.instance === "off")).toBe(false);
    expect(readings.some((r) => r.instance === "on")).toBe(true);
  });
});

describe("session_done — completion past the run-length floor", () => {
  const policy = defaultPolicy(); // session_done floor = 2 min
  const workThen = (id: string, t0: number) =>
    deriveReadings(sources(), system(), [session({ sessionId: id, state: "working", lastActivityAt: t0 })], policy, emptyDeriveState(), t0).next;

  test("a run that met the floor fires once on completion", () => {
    const t0 = 1_000;
    const ds = workThen("r", t0);
    const t1 = t0 + 60_000 * 5;
    const done = deriveReadings(sources(), system(), [session({ sessionId: "r", state: "awaiting", lastActivityAt: t1 })], policy, ds, t1);
    expect(inst(done.readings, "session_done", "r")?.active).toBe(true);
  });

  test("a sub-floor run finishing does not fire", () => {
    const t0 = 1_000;
    const ds = workThen("r", t0);
    const t1 = t0 + 60_000 * 1; // 1 min < 2
    const done = deriveReadings(sources(), system(), [session({ sessionId: "r", state: "awaiting", lastActivityAt: t1 })], policy, ds, t1);
    expect(inst(done.readings, "session_done", "r")?.active).toBe(false);
  });

  test("children still running defer completion until they exit", () => {
    const t0 = 1_000;
    let ds = workThen("r", t0);
    const t1 = t0 + 60_000 * 5;
    const mid = deriveReadings(sources(), system(), [session({ sessionId: "r", state: "awaiting", lastActivityAt: t1, children: [child] })], policy, ds, t1);
    expect(inst(mid.readings, "session_done", "r")?.active).toBe(false); // not done yet
    ds = mid.next;
    const t2 = t1 + 60_000;
    const done = deriveReadings(sources(), system(), [session({ sessionId: "r", state: "awaiting", lastActivityAt: t2 })], policy, ds, t2);
    expect(inst(done.readings, "session_done", "r")?.active).toBe(true); // agent gone → fires
  });
});

describe("session_reminder — recurring nag", () => {
  const MIN = 60_000;

  test("quiet before the threshold, active past it; children in flight suppress it", () => {
    const now = MIN * 30;
    const sessions = [
      session({ sessionId: "fresh", state: "awaiting", lastActivityAt: now - MIN * 5 }), //  5 < 10
      session({ sessionId: "stale", state: "awaiting", lastActivityAt: now - MIN * 20 }), // 20 ≥ 10
      session({ sessionId: "swarm", state: "awaiting", lastActivityAt: now - MIN * 20, children: [child] }),
    ];
    const { readings } = deriveReadings(sources(), system(), sessions, defaultPolicy(), emptyDeriveState(), now);
    // gauge value = minutes waiting; 0 while not genuinely done (children running)
    expect(inst(readings, "session_reminder", "fresh")?.value).toBeCloseTo(5);
    expect(inst(readings, "session_reminder", "stale")?.value).toBeCloseTo(20);
    expect(inst(readings, "session_reminder", "swarm")?.value).toBe(0);
  });

  test("re-fires on the cooldown while it keeps waiting (derive → engine)", () => {
    const policy = defaultPolicy(); // reminder: threshold 10m, cooldown 900s (15m)
    let es: EngineState = {};
    let ds = emptyDeriveState();
    const stepAt = (waitMin: number, now: number) => {
      const d = deriveReadings(sources(), system(), [session({ sessionId: "s", state: "awaiting", lastActivityAt: now - waitMin * MIN })], policy, ds, now);
      const e = evaluate(d.readings, policy, es, now);
      es = e.next;
      ds = d.next;
      return e.fired.map((f) => f.tag);
    };
    expect(stepAt(5, 5 * MIN)).toEqual([]); // below threshold
    expect(stepAt(11, 11 * MIN)).toEqual(["session_reminder:s"]); // first nag
    expect(stepAt(20, 20 * MIN)).toEqual([]); // 9m later — within cooldown
    expect(stepAt(27, 27 * MIN)).toEqual(["session_reminder:s"]); // 16m later — re-nag
  });
});

describe("session_approval — permission prompt", () => {
  const policy = defaultPolicy();

  test("fires on entering an approval prompt (derive → engine)", () => {
    let es: EngineState = {};
    let ds = emptyDeriveState();
    const step = (s: SessionInfo, now: number) => {
      const d = deriveReadings(sources(), system(), [s], policy, ds, now);
      const e = evaluate(d.readings, policy, es, now);
      es = e.next;
      ds = d.next;
      return e.fired.map((f) => f.tag);
    };
    expect(step(session({ sessionId: "p", state: "working", lastActivityAt: 0 }), 0)).toEqual([]);
    expect(step(session({ sessionId: "p", state: "approval", lastActivityAt: 1_000 }), 1_000)).toEqual(["session_approval:p"]);
  });

  test("an approval with something still running behind it does not fire", () => {
    const now = 1_000;
    const { readings } = deriveReadings(sources(), system(), [session({ sessionId: "p", state: "approval", lastActivityAt: now, children: [child] })], policy, emptyDeriveState(), now);
    expect(inst(readings, "session_approval", "p")?.active).toBe(false);
  });
});

describe("box_changed (transition)", () => {
  test("no prior baseline never flags", () => {
    const { readings } = deriveReadings(sources(), system(), [], defaultPolicy(), emptyDeriveState(), 1_000);
    expect(activeOf(readings, "box_changed")).toBe(false);
  });

  test("uptime dropping flags a reboot; total RAM changing flags a resize", () => {
    const prev: DeriveState = { prevUptimeSec: 9_999, prevMemTotalKb: 16_000_000, busySince: {} };
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
