import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { GateDecision } from "./memgate";
import type { SpawnResult } from "./confirm";
import {
  isDriveable,
  MAX_NAME_LEN,
  memGateOutcome,
  originateSession,
  type OriginateDeps,
  type OriginateRequest,
  validateOriginateRequest,
} from "./originate";
import { confineSpawnCwd } from "./spawn";

const REQ: OriginateRequest = { cwd: "/home/you/proj", model: "opus", name: "" };
const UUID = "11112222-3333-4444-5555-666677778888";

// ── AC5.5 — request validation (bad model/cwd/name → reject) ───────────────────
describe("AC5.5 validateOriginateRequest", () => {
  test("a well-formed request is accepted and normalized", () => {
    const r = validateOriginateRequest({ cwd: "/home/you/x", model: "sonnet", name: "  hi  " });
    expect(r).toEqual({ ok: true, value: { cwd: "/home/you/x", model: "sonnet", name: "hi" } });
  });

  test("a missing name is fine — normalized to empty string", () => {
    const r = validateOriginateRequest({ cwd: "/home/you/x", model: "opus" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe("");
  });

  test("a non-allowlisted model is bad-model", () => {
    expect(validateOriginateRequest({ cwd: "/home/you/x", model: "gpt-4o" })).toEqual({
      ok: false,
      reason: "bad-model",
    });
    expect(validateOriginateRequest({ cwd: "/home/you/x", model: "opus[1m]" })).toEqual({
      ok: false,
      reason: "bad-model",
    });
    expect(validateOriginateRequest({ cwd: "/home/you/x", model: 7 })).toEqual({
      ok: false,
      reason: "bad-model",
    });
  });

  test("an empty / non-absolute / non-string cwd is bad-cwd", () => {
    expect(validateOriginateRequest({ cwd: "", model: "opus" }).ok).toBe(false);
    expect(validateOriginateRequest({ cwd: "   ", model: "opus" }).ok).toBe(false);
    expect(validateOriginateRequest({ cwd: "relative/path", model: "opus" })).toEqual({
      ok: false,
      reason: "bad-cwd",
    });
    expect(validateOriginateRequest({ cwd: 42, model: "opus" })).toEqual({
      ok: false,
      reason: "bad-cwd",
    });
  });

  test("an over-long or multi-line name is bad-name", () => {
    expect(
      validateOriginateRequest({ cwd: "/home/you/x", model: "opus", name: "a".repeat(MAX_NAME_LEN + 1) }),
    ).toEqual({ ok: false, reason: "bad-name" });
    expect(
      validateOriginateRequest({ cwd: "/home/you/x", model: "opus", name: "line1\nline2" }),
    ).toEqual({ ok: false, reason: "bad-name" });
    expect(
      validateOriginateRequest({ cwd: "/home/you/x", model: "opus", name: { evil: true } }),
    ).toEqual({ ok: false, reason: "bad-name" });
  });

  test("cwd is checked before model is checked before name (first failing field)", () => {
    // All three bad: cwd wins.
    expect(
      validateOriginateRequest({ cwd: "bad", model: "bad", name: "x".repeat(99) }).ok,
    ).toBe(false);
    expect(
      (validateOriginateRequest({ cwd: "bad", model: "bad", name: "x".repeat(99) }) as { reason: string })
        .reason,
    ).toBe("bad-cwd");
  });
});

// ── AC5.2 — memory-gate branch wiring (block / warn / ok) ──────────────────────
describe("AC5.2 memGateOutcome", () => {
  test("ok ⇒ proceed clean, no caution", () => {
    const d: GateDecision = { band: "ok", usedRatio: 0.4 };
    expect(memGateOutcome(d)).toEqual({ proceed: true });
  });

  test("warn ⇒ proceed WITH a surfaced caution", () => {
    const d: GateDecision = { band: "warn", usedRatio: 0.8 };
    const out = memGateOutcome(d);
    expect(out.proceed).toBe(true);
    if (out.proceed) {
      expect(out.caution).toBeDefined();
      expect(out.caution).toContain("80%");
    }
  });

  test("block ⇒ refuse with the free-memory message naming the idle session to close", () => {
    const d: GateDecision = {
      band: "block",
      usedRatio: 0.95,
      closeCandidate: { uuid: "sess-abc", memoryBytes: 500_000_000, idle: true },
    };
    const out = memGateOutcome(d);
    expect(out.proceed).toBe(false);
    if (!out.proceed) {
      expect(out.message).toMatch(/free memory/i);
      expect(out.message).toContain("sess-abc");
    }
  });

  test("block with no idle candidate still refuses with a free-memory message", () => {
    const d: GateDecision = { band: "block", usedRatio: 0.92, closeCandidate: null };
    const out = memGateOutcome(d);
    expect(out.proceed).toBe(false);
    if (!out.proceed) expect(out.message).toMatch(/free memory/i);
  });
});

// ── AC5.4 — driveable gates on drive-confirm, not boot-confirm ──────────────────
describe("AC5.4 isDriveable predicate", () => {
  const live = new Set(["bifrost-spawn-11112222"]);

  test("a session whose tmuxSession is in the live set is driveable", () => {
    expect(isDriveable({ tmuxSession: "bifrost-spawn-11112222" }, live)).toBe(true);
  });

  test("a booted-but-not-yet-derived session (no tmuxSession) is NOT driveable", () => {
    // The transcript exists (boot-confirmed) but the snapshot hasn't derived a
    // tmuxSession for it yet — resolveTarget says not-injectable, so not ready.
    expect(isDriveable({ tmuxSession: undefined }, live)).toBe(false);
    expect(isDriveable(undefined, live)).toBe(false);
  });

  test("a session whose tmux name isn't in the live set is NOT driveable", () => {
    expect(isDriveable({ tmuxSession: "bifrost-spawn-deadbeef" }, live)).toBe(false);
  });
});

// ── AC5.3 — gate → pending → spawn → active (happy + failure, stubbed spawn) ────
describe("AC5.3 originateSession orchestration", () => {
  /** An in-memory registry + call log so the lifecycle is asserted end-to-end. */
  function harness(opts: {
    gate?: GateDecision;
    spawn?: SpawnResult | (() => Promise<SpawnResult>);
  }) {
    const reg = new Map<string, { state: string; cwd: string; label: string }>();
    const log: string[] = [];
    const deps: OriginateDeps = {
      gate: async () => opts.gate ?? { band: "ok", usedRatio: 0.3 },
      writePending: async (uuid, f) => {
        log.push("writePending");
        reg.set(uuid, { state: "pending", cwd: f.cwd, label: f.label });
      },
      issueSpawn: async () => {
        log.push("issueSpawn");
        const s = opts.spawn ?? ({
          ok: true,
          tmuxSession: "bifrost-spawn-11112222",
          transcriptPath: "/p/x.jsonl",
        } as SpawnResult);
        return typeof s === "function" ? s() : s;
      },
      markActive: async (uuid) => {
        log.push("markActive");
        const e = reg.get(uuid);
        if (e) e.state = "active";
      },
      remove: async (uuid) => {
        log.push("remove");
        reg.delete(uuid);
      },
    };
    return { reg, log, deps };
  }

  test("happy path: pending written BEFORE spawn, then flipped active; ok with the live name", async () => {
    const { reg, log, deps } = harness({});
    const out = await originateSession(UUID, REQ, deps);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.tmuxSession).toBe("bifrost-spawn-11112222");
      expect(out.transcriptPath).toBe("/p/x.jsonl");
    }
    // ordering: writePending strictly before issueSpawn; markActive after confirm.
    expect(log).toEqual(["writePending", "issueSpawn", "markActive"]);
    expect(reg.get(UUID)?.state).toBe("active");
  });

  test("block: gate refuses BEFORE any registry/spawn mutation — no ghost", async () => {
    const { reg, log, deps } = harness({
      gate: {
        band: "block",
        usedRatio: 0.96,
        closeCandidate: { uuid: "idle-1", memoryBytes: 9, idle: true },
      },
    });
    const out = await originateSession(UUID, REQ, deps);
    expect(out).toMatchObject({ ok: false, reason: "blocked" });
    if (!out.ok && out.reason === "blocked") expect(out.message).toContain("idle-1");
    // NOTHING was written or spawned.
    expect(log).toEqual([]);
    expect(reg.size).toBe(0);
  });

  test("spawn failure (collision): pending row is DELETED — no ghost — and surfaced loudly", async () => {
    const { reg, log, deps } = harness({
      spawn: { ok: false, reason: "collision", stderr: "duplicate session" },
    });
    const out = await originateSession(UUID, REQ, deps);
    expect(out).toMatchObject({ ok: false, reason: "spawn-failed" });
    if (!out.ok && out.reason === "spawn-failed") expect(out.detail).toBe("collision");
    expect(log).toEqual(["writePending", "issueSpawn", "remove"]);
    expect(reg.has(UUID)).toBe(false); // pending row removed — no ghost
  });

  test("spawn failure (confirm-timeout): pending deleted, never flipped active", async () => {
    const { reg, log, deps } = harness({ spawn: { ok: false, reason: "confirm-timeout" } });
    const out = await originateSession(UUID, REQ, deps);
    expect(out).toMatchObject({ ok: false, reason: "spawn-failed", detail: "confirm-timeout" });
    expect(log).not.toContain("markActive");
    expect(reg.has(UUID)).toBe(false);
  });

  test("spawn throws (e.g. missing-binary assertion): pending deleted, surfaced", async () => {
    const { reg, log, deps } = harness({
      spawn: async () => {
        throw new Error("claude binary not found");
      },
    });
    const out = await originateSession(UUID, REQ, deps);
    expect(out).toMatchObject({ ok: false, reason: "spawn-failed" });
    if (!out.ok && out.reason === "spawn-failed") expect(out.detail).toMatch(/not found/);
    expect(log).toEqual(["writePending", "issueSpawn", "remove"]);
    expect(reg.has(UUID)).toBe(false);
  });

  test("warn band: still proceeds, and the caution rides through to the ok outcome", async () => {
    const { deps } = harness({ gate: { band: "warn", usedRatio: 0.82 } });
    const out = await originateSession(UUID, REQ, deps);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.caution).toContain("82%");
  });
});

// ── AC5.5 — the endpoint's reject sequence: validate THEN confine the cwd ───────
// The /api/originate route maps each of these to a 400. This mirrors that exact
// two-step decision (sync field validation, then async path confinement) so the
// rejection contract is tested where the route relies on it.
describe("AC5.5 endpoint rejection sequence (validate → confine)", () => {
  /** What the route returns: 400 with a field reason, or admits with a confined cwd. */
  // `root` defaults to the real home root, exactly as the route does. The
  // admitted case overrides it with a scratch directory so the test asserts the
  // confinement contract rather than the layout of whatever box it runs on.
  async function decideEndpoint(
    body: Record<string, unknown>,
    root?: string,
  ): Promise<{ status: 400; reason: string } | { status: 200; cwd: string }> {
    const v = validateOriginateRequest(body);
    if (!v.ok) return { status: 400, reason: v.reason };
    const confined = await confineSpawnCwd(v.value.cwd, root ?? homedir());
    if (!confined.ok) return { status: 400, reason: "bad-cwd" };
    return { status: 200, cwd: confined.path };
  }

  test("a bad model is a 400 (bad-model) — never reaches confinement", async () => {
    expect(await decideEndpoint({ cwd: "/home/you", model: "gpt-4o" })).toEqual({
      status: 400,
      reason: "bad-model",
    });
  });

  test("a bad name is a 400 (bad-name)", async () => {
    expect(
      await decideEndpoint({ cwd: "/home/you", model: "opus", name: "x\ny" }),
    ).toEqual({ status: 400, reason: "bad-name" });
  });

  test("a syntactically bad cwd is a 400 (bad-cwd) before confinement", async () => {
    expect(await decideEndpoint({ cwd: "relative", model: "opus" })).toEqual({
      status: 400,
      reason: "bad-cwd",
    });
  });

  test("a well-formed request pointing OUTSIDE the home root is a 400 (confinement reject)", async () => {
    // Passes field validation but fails the canonicalizing confinement → 400.
    expect(await decideEndpoint({ cwd: "/etc", model: "opus" })).toEqual({
      status: 400,
      reason: "bad-cwd",
    });
  });

  test("a `..` escape out of the home root is rejected by confinement → 400", async () => {
    const r = await decideEndpoint({
      cwd: join(homedir(), "../../etc"),
      model: "opus",
    });
    expect(r.status).toBe(400);
  });

  test("a valid cwd under the home root is admitted with the canonical path", async () => {
    // tmpdir() can itself be a symlink, so canonicalize the base up front —
    // confinement compares canonical paths (same rationale as confine.test.ts).
    const base = realpathSync(await mkdtemp(join(tmpdir(), "bifrost-originate-")));
    const inside = join(base, "proj");
    await mkdir(inside);
    try {
      const r = await decideEndpoint({ cwd: inside, model: "opus" }, base);
      expect(r.status).toBe(200);
      if (r.status === 200) expect(r.cwd).toBe(inside);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
