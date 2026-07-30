import { describe, expect, test } from "bun:test";
import { buildDiagnostics } from "./diagnostics";
import type { SystemDiagnostics } from "../../../shared/types";

const HEALTHY: SystemDiagnostics = {
  oomKill: 0,
  ramWall: 0,
  swapPct: 12,
  swapCurrentKb: 512 * 1024,
  sliceMaxKb: 24 * 1024 * 1024,
  psiMemSome: 3,
  servicesDown: [],
  limitsHealthy: true,
};

const row = (key: string, d = HEALTHY) =>
  buildDiagnostics(d).rows.find((r) => r.key === key)!;

describe("buildDiagnostics — System pane health view-model", () => {
  test("a healthy box: every row ok, overall ok", () => {
    const view = buildDiagnostics(HEALTHY);
    expect(view.overall).toBe("ok");
    expect(view.rows.every((r) => r.tone === "ok")).toBe(true);
  });

  test("PSI bands mirror the mem_stall default (warn 40, danger 70)", () => {
    expect(row("mem_pressure", { ...HEALTHY, psiMemSome: 39 }).tone).toBe("ok");
    expect(row("mem_pressure", { ...HEALTHY, psiMemSome: 40 }).tone).toBe("warn");
    expect(row("mem_pressure", { ...HEALTHY, psiMemSome: 71 }).tone).toBe("danger");
  });

  test("swap bands mirror swap_ceiling default (warn 70, danger 90)", () => {
    expect(row("swap", { ...HEALTHY, swapPct: 69 }).tone).toBe("ok");
    expect(row("swap", { ...HEALTHY, swapPct: 70 }).tone).toBe("warn");
    expect(row("swap", { ...HEALTHY, swapPct: 95 }).tone).toBe("danger");
  });

  test("monotonic counters read 'none' at 0, warn when they've fired", () => {
    expect(row("oom_kill").value).toBe("none");
    const hit = row("oom_kill", { ...HEALTHY, oomKill: 2 });
    expect(hit.value).toBe("2");
    expect(hit.tone).toBe("warn");
    expect(row("ram_wall", { ...HEALTHY, ramWall: 1 }).tone).toBe("warn");
  });

  test("a down service is danger and lists the units", () => {
    const r = row("services", { ...HEALTHY, servicesDown: ["ssh", "caddy"] });
    expect(r.tone).toBe("danger");
    expect(r.value).toBe("ssh, caddy");
    expect(r.sub).toBe("2 down");
  });

  test("an unhealthy safeguard surfaces its reason as danger", () => {
    const r = row("safeguard", {
      ...HEALTHY,
      limitsHealthy: false,
      limitsReason: "slice memory.max reverted to unbounded",
    });
    expect(r.tone).toBe("danger");
    expect(r.value).toBe("slice memory.max reverted to unbounded");
  });

  test("slice cap is informational: formatted, or 'unbounded' when null", () => {
    expect(row("slice_cap").value).toBe("24.0G");
    expect(row("slice_cap").tone).toBe("ok");
    expect(row("slice_cap", { ...HEALTHY, sliceMaxKb: null }).value).toBe("unbounded");
  });

  test("overall rolls up to the worst row's tone", () => {
    expect(buildDiagnostics({ ...HEALTHY, oomKill: 1 }).overall).toBe("warn");
    expect(buildDiagnostics({ ...HEALTHY, servicesDown: ["ssh"] }).overall).toBe("danger");
    // a warn row does not mask a danger row
    expect(
      buildDiagnostics({ ...HEALTHY, oomKill: 1, limitsHealthy: false }).overall,
    ).toBe("danger");
  });
});
