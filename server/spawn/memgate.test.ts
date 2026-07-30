import { describe, expect, test } from "bun:test";

import {
  DEFAULT_BANDS,
  decideMemoryGate,
  heaviestIdleSession,
  reclaimableFromStat,
  type TrackedSession,
} from "./memgate";

// A round cap so a `ratio` round-trips to an EXACT used fraction at the boundary
// (Math.round(MAX*ratio)/MAX must equal ratio, or an inclusive `>=` edge flips). The
// default bands are multiples of 0.005, so MAX=200000 makes every boundary integral.
const MAX = 200_000;
/** A reading whose used ratio is exactly `ratio` of MAX. */
const at = (ratio: number) => {
  const current = MAX * ratio;
  if (!Number.isInteger(current)) {
    throw new Error(`at(${ratio}) is not an exact integer of MAX=${MAX} — pick a rounder ratio`);
  }
  return { current, max: MAX };
};

// ── AC4.5 — three bands, each tested AT its boundary ──────────────────────────
describe("AC4.5 pure gate over injected slice headroom: block / warn / ok bands", () => {
  test("ok band: just under the caution threshold ⇒ ok", () => {
    const r = decideMemoryGate(at(DEFAULT_BANDS.caution - 0.001));
    expect(r.band).toBe("ok");
  });

  test("caution boundary: used == caution ⇒ warn (lower edge inclusive)", () => {
    const r = decideMemoryGate(at(DEFAULT_BANDS.caution));
    expect(r.band).toBe("warn");
  });

  test("warn band interior: between caution and hardFloor ⇒ warn", () => {
    const mid = (DEFAULT_BANDS.caution + DEFAULT_BANDS.hardFloor) / 2;
    expect(decideMemoryGate(at(mid)).band).toBe("warn");
  });

  test("hard-floor boundary: used == hardFloor ⇒ block (lower edge inclusive)", () => {
    const r = decideMemoryGate(at(DEFAULT_BANDS.hardFloor));
    expect(r.band).toBe("block");
  });

  test("just below the hard floor ⇒ still warn, not block", () => {
    const r = decideMemoryGate(at(DEFAULT_BANDS.hardFloor - 0.001));
    expect(r.band).toBe("warn");
  });

  test("the decision carries the computed usedRatio", () => {
    const r = decideMemoryGate({ current: MAX / 2, max: MAX });
    expect(r.usedRatio).toBeCloseTo(0.5, 6);
  });

  test("a missing/unlimited cap (max ≤ 0) fails to block, never waves a spawn through", () => {
    // memory.max == "max" surfaces as max=0 from the adapter; the dangerous case.
    expect(decideMemoryGate({ current: 1_000, max: 0 }).band).toBe("block");
    expect(decideMemoryGate({ current: 1_000, max: -1 }).band).toBe("block");
  });

  test("custom bands relocate the boundaries", () => {
    const bands = { hardFloor: 0.5, caution: 0.25 };
    expect(decideMemoryGate(at(0.24), [], bands).band).toBe("ok");
    expect(decideMemoryGate(at(0.25), [], bands).band).toBe("warn");
    expect(decideMemoryGate(at(0.5), [], bands).band).toBe("block");
  });
});

// ── AC4.6 — on block, identify the heaviest IDLE tracked session to close ──────
describe("AC4.6 block names the heaviest idle Bifrost-tracked session to close", () => {
  const sessions: TrackedSession[] = [
    { uuid: "active-huge", memoryBytes: 900_000_000, idle: false },
    { uuid: "idle-small", memoryBytes: 100_000_000, idle: true },
    { uuid: "idle-big", memoryBytes: 400_000_000, idle: true },
    { uuid: "idle-mid", memoryBytes: 250_000_000, idle: true },
  ];

  test("block selects the largest IDLE session, ignoring a heavier ACTIVE one", () => {
    const r = decideMemoryGate(at(0.95), sessions);
    expect(r.band).toBe("block");
    if (r.band === "block") {
      // idle-big (400 MB) wins; active-huge (900 MB) is excluded — never close active.
      expect(r.closeCandidate?.uuid).toBe("idle-big");
    }
  });

  test("block with NO idle session ⇒ closeCandidate is null", () => {
    const allActive: TrackedSession[] = [
      { uuid: "a", memoryBytes: 500_000_000, idle: false },
      { uuid: "b", memoryBytes: 300_000_000, idle: false },
    ];
    const r = decideMemoryGate(at(0.95), allActive);
    if (r.band === "block") expect(r.closeCandidate).toBeNull();
    else throw new Error("expected block band");
  });

  test("block with no tracked sessions at all ⇒ closeCandidate is null", () => {
    const r = decideMemoryGate(at(0.95));
    if (r.band === "block") expect(r.closeCandidate).toBeNull();
    else throw new Error("expected block band");
  });

  test("warn/ok bands never carry a closeCandidate (no field on those variants)", () => {
    const warn = decideMemoryGate(at(DEFAULT_BANDS.caution), sessions);
    expect(warn).not.toHaveProperty("closeCandidate");
    const ok = decideMemoryGate(at(0.1), sessions);
    expect(ok).not.toHaveProperty("closeCandidate");
  });

  test("heaviestIdleSession ties resolve to the first seen (stable)", () => {
    const tied: TrackedSession[] = [
      { uuid: "first", memoryBytes: 200_000_000, idle: true },
      { uuid: "second", memoryBytes: 200_000_000, idle: true },
    ];
    expect(heaviestIdleSession(tied)?.uuid).toBe("first");
  });

  test("heaviestIdleSession returns null when every session is active", () => {
    expect(
      heaviestIdleSession([{ uuid: "x", memoryBytes: 9, idle: false }]),
    ).toBeNull();
  });
});

// ── reclaimable page cache is subtracted before banding (the over-block fix) ───
describe("reclaimable page cache is excluded from pressure", () => {
  const MAXB = 1_000;
  test("a reading that's ≥block by raw current drops to ok once cache is subtracted", () => {
    // 950/1000 = 95% raw ⇒ would block; 600 of it is reclaimable cache ⇒ effective
    // 350/1000 = 35% ⇒ ok. This is the over-block bug the fix closes.
    const r = decideMemoryGate({ current: 950, max: MAXB, reclaimable: 600 });
    expect(r.band).toBe("ok");
    expect(r.usedRatio).toBeCloseTo(0.35, 5);
  });

  test("absent reclaimable behaves like the pre-fix raw ratio", () => {
    expect(decideMemoryGate({ current: 950, max: MAXB }).band).toBe("block");
  });

  test("reclaimable larger than current floors the ratio at 0, never negative", () => {
    const r = decideMemoryGate({ current: 100, max: MAXB, reclaimable: 500 });
    expect(r.usedRatio).toBe(0);
    expect(r.band).toBe("ok");
  });
});

describe("reclaimableFromStat", () => {
  test("sums inactive_file + active_file from a cgroup memory.stat body", () => {
    const stat = ["anon 1000", "file 700", "inactive_file 200", "active_file 500", "slab 50"].join(
      "\n",
    );
    expect(reclaimableFromStat(stat)).toBe(700);
  });

  test("absent file lines ⇒ 0 (conservative)", () => {
    expect(reclaimableFromStat("anon 1000\nslab 50")).toBe(0);
  });

  test("ignores unparseable values", () => {
    expect(reclaimableFromStat("inactive_file x\nactive_file 500")).toBe(500);
  });
});

describe("decideMemoryGate — uncapped slice falls back to system budget (H1)", () => {
  const uncapped = { current: 999, max: 0 }; // memory.max == "max" → coerced to 0

  test("uncapped slice with abundant system RAM → ok (was: block every spawn)", () => {
    const d = decideMemoryGate(uncapped, [], DEFAULT_BANDS, {
      totalKb: 16_000_000,
      availKb: 12_000_000,
    }); // 25% used
    expect(d.band).toBe("ok");
  });

  test("uncapped slice with a nearly-full system → block (real pressure still caught)", () => {
    const d = decideMemoryGate(uncapped, [], DEFAULT_BANDS, {
      totalKb: 4_000_000,
      availKb: 200_000,
    }); // 95% used
    expect(d.band).toBe("block");
  });

  test("uncapped slice + system warn band → warn", () => {
    const d = decideMemoryGate(uncapped, [], DEFAULT_BANDS, {
      totalKb: 4_000_000,
      availKb: 800_000,
    }); // 80% used
    expect(d.band).toBe("warn");
  });

  test("no cap AND no system reading → fail closed (block)", () => {
    expect(decideMemoryGate(uncapped, []).band).toBe("block");
    expect(decideMemoryGate(uncapped, [], DEFAULT_BANDS, { totalKb: 0, availKb: 0 }).band).toBe("block");
  });

  test("a capped slice ignores the system fallback (unchanged behavior)", () => {
    const capped = { current: 100, max: 1000, reclaimable: 0 }; // 10% of the cap
    const d = decideMemoryGate(capped, [], DEFAULT_BANDS, { totalKb: 4_000_000, availKb: 100_000 });
    expect(d.band).toBe("ok"); // the cap wins; the near-full system doesn't matter
  });
});
