/**
 * Contract tests — each assertion traces to a stated requirement, not to the
 * implementation's current output. If one fails after a refactor, the FEATURE
 * broke; do not adjust the expectation without re-deciding the requirement.
 */
import { describe, expect, test } from "bun:test";
import {
  groupChildren,
  gaugeModel,
  fmtWindow,
  stateStripe,
  glyphForModel,
} from "./cardModel";
import type { ChildProc, SessionInfo } from "../../../shared/types";

const child = (over: Partial<ChildProc>): ChildProc => ({
  pid: Math.floor(Math.random() * 100000),
  etime: "01:00",
  rssKb: 100,
  cpu: 1,
  command: "cmd",
  ...over,
});

const s = (over: Partial<SessionInfo>): SessionInfo => ({
  sessionId: "x",
  live: true,
  cwd: "/x",
  lastActivityAt: 0,
  ...over,
});

describe("groupChildren", () => {
  // Requirement: a fan-out of same-named agents is ONE fact — fold with ×N
  // and the combined footprint (sum rss, sum cpu).
  test("same-named children fold with aggregated footprint", () => {
    const probe = (pid: number) =>
      child({ pid, name: "Probe the brain", rssKb: 250, cpu: 3 });
    const groups = groupChildren([probe(1), probe(2), probe(3)]);
    expect(groups.length).toBe(1);
    expect(groups[0].n).toBe(3);
    expect(groups[0].rssKb).toBe(750);
    expect(groups[0].cpu).toBe(9);
  });
  // Requirement: unnamed children are distinct work — NEVER fold, even with
  // identical commands.
  test("unnamed children never fold", () => {
    const groups = groupChildren([
      child({ pid: 1, command: "sleep 60" }),
      child({ pid: 2, command: "sleep 60" }),
    ]);
    expect(groups.length).toBe(2);
    expect(groups.every((g) => g.n === 1)).toBe(true);
  });
  test("differently-named children stay separate", () => {
    const groups = groupChildren([
      child({ pid: 1, name: "Run tests" }),
      child({ pid: 2, name: "Build bundle" }),
    ]);
    expect(groups.length).toBe(2);
  });
  test("a single named child keeps its per-process identity (n=1)", () => {
    const groups = groupChildren([child({ pid: 7, name: "Run tests" })]);
    expect(groups[0].n).toBe(1);
    expect(groups[0].c.pid).toBe(7);
  });
});

describe("gaugeModel", () => {
  // Requirement: no usage data -> no gauge (placeholder), never a fake 0%.
  test("no contextTokens yields null", () => {
    expect(gaugeModel(s({}))).toBeNull();
  });
  // Requirement: unknown window falls back to the conservative 200K and is
  // marked unmeasured so the UI renders "~".
  test("missing window defaults to 200K, unmeasured", () => {
    const g = gaugeModel(s({ contextTokens: 50_000 }))!;
    expect(g.window).toBe(200_000);
    expect(g.measured).toBe(false);
  });
  test("lookup source is unmeasured; any other source is measured", () => {
    expect(
      gaugeModel(
        s({ contextTokens: 1, contextWindow: 200_000, contextWindowSrc: "lookup" }),
      )!.measured,
    ).toBe(false);
    expect(
      gaugeModel(
        s({ contextTokens: 1, contextWindow: 1_000_000, contextWindowSrc: "model-log" }),
      )!.measured,
    ).toBe(true);
  });
  // Requirement: the gauge turns danger past the 75% line — at 75% it is
  // still calm (the line marks the threshold, not the warning).
  test("danger strictly past 75%", () => {
    const at75 = gaugeModel(
      s({ contextTokens: 750_000, contextWindow: 1_000_000, contextWindowSrc: "model-log" }),
    )!;
    expect(at75.danger).toBe(false);
    const past = gaugeModel(
      s({ contextTokens: 750_001, contextWindow: 1_000_000, contextWindowSrc: "model-log" }),
    )!;
    expect(past.danger).toBe(true);
  });
  // Requirement: usage beyond the window renders full, never overflows.
  test("ratio clamps at 1 when usage exceeds the window", () => {
    const g = gaugeModel(
      s({ contextTokens: 340_000, contextWindow: 200_000, contextWindowSrc: "lookup" }),
    )!;
    expect(g.ratio).toBe(1);
  });
});

describe("fmtWindow", () => {
  test("known windows read clean", () => {
    expect(fmtWindow(1_000_000)).toBe("1M");
    expect(fmtWindow(200_000)).toBe("200K");
  });
});

describe("stateStripe", () => {
  // Requirement: the stripe mirrors the state badge's color language.
  test("maps each state to its tone", () => {
    expect(stateStripe(s({ state: "approval" }))).toBe("danger");
    expect(stateStripe(s({ state: "awaiting" }))).toBe("gold");
    expect(stateStripe(s({ state: "paused" }))).toBe("mute");
    expect(stateStripe(s({ state: "working" }))).toBe("auto");
  });
});

describe("glyphForModel", () => {
  // Requirement: the pill's family classification is the SAME one the model
  // filter uses — variant suffixes don't change the family.
  test("families get their glyphs, variant-agnostic", () => {
    expect(glyphForModel("claude-fable-5[1m]").glyph).toBe("◆");
    expect(glyphForModel("claude-opus-4-8").glyph).toBe("●");
    expect(glyphForModel("claude-sonnet-4-6").glyph).toBe("▲");
    expect(glyphForModel("claude-haiku-4-5-20251001").glyph).toBe("○");
    expect(glyphForModel("mystery-model-9").glyph).toBe("·");
  });
});
