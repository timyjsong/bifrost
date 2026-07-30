import { describe, expect, test } from "bun:test";
import { resumeOutcome, restartOutcome } from "./recycle";

const UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// ── resume (2-6) — server verdict → UI outcome ─────────────────────────────────
describe("resumeOutcome", () => {
  test("ok opens the drive view on the confirmed session", () => {
    expect(
      resumeOutcome(UUID, { ok: true, sessionId: UUID, tmuxSession: "x", driveable: true }),
    ).toEqual({ kind: "open-drive", sessionId: UUID });
  });

  test("already-live routes to the drive view on the SAME uuid (AC6.3)", () => {
    expect(resumeOutcome(UUID, { ok: false, reason: "already-live", route: "drive" })).toEqual({
      kind: "open-drive",
      sessionId: UUID,
    });
  });

  test("already-starting (concurrent resume holds the lock) is a retryable error", () => {
    const o = resumeOutcome(UUID, { ok: false, reason: "already-starting" });
    expect(o.kind).toBe("error");
    expect((o as { message: string }).message).toContain("starting");
  });

  test("not-resumable surfaces the server's detail", () => {
    const o = resumeOutcome(UUID, { ok: false, reason: "not-resumable", detail: "no transcript" });
    expect(o.kind).toBe("error");
    expect((o as { message: string }).message).toContain("no transcript");
  });

  test("degraded with a cwd names the missing folder (AC6.4 — surfaced, not launched)", () => {
    const o = resumeOutcome(UUID, {
      ok: false,
      reason: "degraded",
      detail: "cwd missing",
      cwd: "/home/you/gone",
    });
    expect(o.kind).toBe("error");
    expect((o as { message: string }).message).toContain("/home/you/gone");
  });

  test("spawn-failed surfaces the detail", () => {
    const o = resumeOutcome(UUID, { ok: false, reason: "spawn-failed", detail: "confirm-timeout" });
    expect(o.kind).toBe("error");
    expect((o as { message: string }).message).toContain("confirm-timeout");
  });

  test("an unrecognized body is an error, never a silent open", () => {
    expect(resumeOutcome(UUID, {}).kind).toBe("error");
    expect(resumeOutcome(UUID, null).kind).toBe("error");
  });
});

// ── restart (2-7) — server verdict → UI outcome ────────────────────────────────
describe("restartOutcome", () => {
  test("ok opens the drive view on the returned id (same uuid on resume-restart)", () => {
    expect(
      restartOutcome({ ok: true, mode: "resume", sessionId: UUID, driveable: true }),
    ).toEqual({ kind: "open-drive", sessionId: UUID });
  });

  test("ok fresh opens the NEW session id (AC7.3 — new conversation, old transcript kept)", () => {
    const fresh = "ffffffff-1111-2222-3333-444444444444";
    expect(restartOutcome({ ok: true, mode: "fresh", sessionId: fresh })).toEqual({
      kind: "open-drive",
      sessionId: fresh,
    });
  });

  test("ok without a session id is an error, never a blind open", () => {
    expect(restartOutcome({ ok: true }).kind).toBe("error");
  });

  test("session-gone points at the resume path", () => {
    const o = restartOutcome({ ok: false, reason: "session-gone" });
    expect(o.kind).toBe("error");
    expect((o as { message: string }).message.toLowerCase()).toContain("resume");
  });

  test("kill-refused / still-alive say nothing was relaunched", () => {
    const refused = restartOutcome({ ok: false, reason: "kill-refused", rc: 1 });
    expect(refused.kind).toBe("error");
    expect((refused as { message: string }).message).toContain("nothing was killed");
    const alive = restartOutcome({ ok: false, reason: "still-alive" });
    expect(alive.kind).toBe("error");
    expect((alive as { message: string }).message).toContain("no relaunch");
  });

  test("an unrecognized body is an error", () => {
    expect(restartOutcome({}).kind).toBe("error");
    expect(restartOutcome(undefined).kind).toBe("error");
  });
});
