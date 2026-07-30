/**
 * Restart — the resume/fresh recycle of a LIVE session. Restart kills the running
 * claude and relaunches it, in one of two modes:
 *   - resume-restart (default): relaunch `--resume <uuid>` — same conversation,
 *     same transcript, history kept.
 *   - fresh-restart: spawn a NEW `--session-id <newUuid>` session in the SAME cwd,
 *     a clean conversation — the OLD transcript is left untouched (never deleted).
 *
 * The whole point of restart over a plain kill+spawn is the SEQUENCING (REDTEAM M4):
 *  - AC7.1: BOTH modes require an explicit confirm-before-kill. The kill destroys
 *    in-flight turn state, so restart never fires off a stale snapshot's "looks
 *    live" — it proceeds ONLY on a positive confirm taken at click time.
 *  - AC7.2: the kill is sequenced by DIRECT PROBES — `tmux kill-session`'s rc plus a
 *    fresh `/proc`-gone read (and a fresh tmux has-session) — never the ≤3s tick
 *    snapshot. The relaunch happens ONLY after confirmed-dead, under the per-uuid
 *    lock, so a second claude can never land on a transcript the dying one still writes.
 *  - AC7.3: resume relaunches `--resume <uuid>`; fresh spawns a new `--session-id` in
 *    the same cwd and does NOT delete the old transcript.
 *
 * Layering mirrors resume.ts: this module is the PURE confirm-gate decision + the
 * orchestration over INJECTED effects (the kill issuer, the fresh dead-probe, the
 * spawn issuers). The impure endpoint (server/index.ts) supplies the real tmux /
 * /proc / filesystem effects and holds the per-uuid lock at the route.
 */
import { pidMatchesStart } from "./resume";
import type { SpawnResult } from "./confirm";

// ── AC7.1 — the confirm-before-kill gate ────────────────────────────────────────

export type RestartMode = "resume" | "fresh";

/** The default restart mode: resume (keep history) when the request omits a mode. */
export const DEFAULT_RESTART_MODE: RestartMode = "resume";

export type RestartGate =
  | { proceed: true; mode: RestartMode }
  // The kill destroys in-flight turn state — never proceed without an explicit confirm.
  | { proceed: false; reason: "unconfirmed" }
  // A mode that isn't resume/fresh is a bad request, not a silent default.
  | { proceed: false; reason: "bad-mode" };

/** The raw restart request as it arrives off the wire (untrusted shapes). */
export interface RestartInput {
  /** Must be exactly `true` — the explicit confirm-before-kill (AC7.1). */
  confirm?: unknown;
  /** "resume" (default) or "fresh"; absent ⇒ resume. */
  mode?: unknown;
}

/**
 * The confirm-before-kill gate (AC7.1). Restart proceeds ONLY when `confirm === true`
 * (the kill loses in-flight turn state, so an implicit/absent confirm is refused, not
 * defaulted). The mode defaults to resume when omitted; any other value is a bad
 * request. Pure — decides on the request shape, kills nothing itself.
 */
export function decideRestart(input: RestartInput): RestartGate {
  if (input.confirm !== true) return { proceed: false, reason: "unconfirmed" };
  let mode: RestartMode;
  if (input.mode === undefined || input.mode === null) {
    mode = DEFAULT_RESTART_MODE;
  } else if (input.mode === "resume" || input.mode === "fresh") {
    mode = input.mode;
  } else {
    return { proceed: false, reason: "bad-mode" };
  }
  return { proceed: true, mode };
}

// ── AC7.2 — confirmed-dead via DIRECT PROBES (kill rc + /proc gone), never snapshot ─

/** The fresh, direct death signals the kill sequence is confirmed over. Each is read
 *  FRESH per poll — sync (a stubbed bool) or async (a real /proc + tmux read). */
export interface KillProbe {
  /** Is the session's live pid still present in /proc (fresh read), or gone? */
  procAlive: () => boolean | Promise<boolean>;
  /** Is the session's tmux pane still in the LIVE tmux set (fresh probe)? */
  tmuxLive: () => boolean | Promise<boolean>;
}

export interface KillDeps extends KillProbe {
  /** Issue `tmux kill-session -t <name>`; resolves the rc (0 ⇒ accepted by tmux). */
  killSession: () => Promise<number>;
  /** Polling budget for confirmed-dead. */
  timeoutMs: number;
  /** Poll interval. */
  pollMs?: number;
  /** Injectable clock — deterministic in tests. */
  now?: () => number;
  /** Injectable sleep — deterministic in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export type KillOutcome =
  // Confirmed dead by direct probes: tmux accepted the kill AND /proc + tmux are gone.
  | { dead: true }
  // tmux refused the kill (rc≠0) — surface, do NOT relaunch (we never confirmed dead).
  | { dead: false; reason: "kill-refused"; rc: number }
  // Killed but the pid / pane is still observed after the budget — never relaunch onto
  // a possibly-still-writing process. Surface so the caller can retry / report stuck.
  | { dead: false; reason: "still-alive" };

/**
 * Sequence the kill by DIRECT PROBES (AC7.2 / M4). Order is load-bearing:
 *   1. `tmux kill-session` — branch on its rc FIRST. rc≠0 ⇒ tmux refused (no session,
 *      or error); we have NOT confirmed the process dead, so do NOT relaunch.
 *   2. Poll FRESH `/proc` (the live pid gone) AND a fresh `tmux has-session` until
 *      BOTH report gone — never the ≤3s tick snapshot. A pid still in /proc means the
 *      process is still draining (could still write the transcript); we wait it out.
 *   3. Confirmed-dead only when both probes are gone within the budget; else
 *      "still-alive" (surface, never relaunch onto a live writer).
 * The caller runs this INSIDE the per-uuid lock so the relaunch can never race a
 * concurrent restart/resume on the same uuid.
 */
export async function confirmKilled(deps: KillDeps): Promise<KillOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 200;

  const rc = await deps.killSession();
  if (rc !== 0) return { dead: false, reason: "kill-refused", rc };

  const deadline = now() + deps.timeoutMs;
  // Read the death signals FRESH each poll — /proc and the live tmux set directly,
  // never the snapshot's cached membership.
  for (;;) {
    const procGone = !(await deps.procAlive());
    const tmuxGone = !(await deps.tmuxLive());
    if (procGone && tmuxGone) return { dead: true };
    if (now() >= deadline) return { dead: false, reason: "still-alive" };
    await sleep(pollMs);
  }
}

/**
 * A fresh `/proc`-gone probe for a session's recorded pid (AC7.2). Reuses the resume
 * module's procStart reuse guard: alive ⇔ `/proc/<pid>` exists AND (if a procStart was
 * recorded) its starttime still matches — a recycled pid reading a DIFFERENT process is
 * NOT our session still alive. Any /proc read failure ⇒ gone. When no pid is known
 * (the session carried none), the process is treated as not-alive — there is nothing
 * to wait on, and tmux-gone alone then confirms the pane is down.
 */
export function procAliveFor(
  pid: number | undefined,
  procStart: string | undefined,
  readStat?: (pid: number) => string,
): boolean {
  if (pid === undefined) return false;
  return readStat
    ? pidMatchesStart(pid, procStart, readStat)
    : pidMatchesStart(pid, procStart);
}

// ── AC7.1/AC7.2/AC7.3 — the restart orchestration ───────────────────────────────

/** The effects the restart orchestration drives — injected so every branch is tested
 *  without real claude / tmux / a live session. */
export interface RestartDeps {
  /** Sequence the kill by direct probes (AC7.2). */
  confirmKilled: () => Promise<KillOutcome>;
  /** The live session's read-back cwd (the same cwd both modes relaunch in). undefined
   *  ⇒ we couldn't read where it ran, so there is nothing to relaunch in. */
  readBackCwd: () => Promise<string | undefined>;
  /** Issue the resume relaunch `--resume <uuid>` cd'd to cwd (AC7.3 resume mode). */
  issueResume: (uuid: string, cwd: string) => Promise<SpawnResult>;
  /** Issue the fresh relaunch `--session-id <newUuid>` in the same cwd (AC7.3 fresh).
   *  The model is the relaunch model for a fresh session (the live one's, or a default
   *  picked by the caller). */
  issueFresh: (newUuid: string, cwd: string) => Promise<SpawnResult>;
  /** Mint the NEW uuid a fresh-restart pins (`--session-id`). Injectable for tests. */
  newUuid: () => string;
}

export type RestartOutcome =
  // Relaunched. `uuid` is the conversation now live: the SAME uuid for resume, the
  // NEW uuid for fresh. `mode` echoes which path ran.
  | { ok: true; mode: RestartMode; uuid: string; tmuxSession: string; transcriptPath: string }
  // The confirm gate refused (AC7.1) — no kill was issued.
  | { ok: false; reason: "unconfirmed" | "bad-mode" }
  // The kill sequence did not confirm dead (AC7.2) — no relaunch.
  | { ok: false; reason: "kill-refused"; rc: number }
  | { ok: false; reason: "still-alive" }
  // We couldn't read the cwd to relaunch in.
  | { ok: false; reason: "cwd-unreadable" }
  // The relaunch spawn itself failed (collision / confirm-timeout / threw).
  | { ok: false; reason: "spawn-failed"; detail: string };

/**
 * Run restart end-to-end (AC7.1/7.2/7.3) over injected effects, for an
 * ALREADY-confirm-gated request (the caller ran decideRestart and passes the mode).
 * Order is load-bearing and runs INSIDE the per-uuid lock the caller holds:
 *   1. confirmKilled — kill the live claude and confirm-dead by DIRECT PROBES
 *      (AC7.2). On kill-refused / still-alive, surface and do NOT relaunch.
 *   2. Read back the cwd both modes relaunch in (the dead session's own cwd).
 *   3. Relaunch:
 *        - resume: `--resume <uuid>` (same conversation, AC7.3).
 *        - fresh: a NEW uuid, `--session-id <newUuid>` in the SAME cwd; the old
 *          transcript is left untouched (this orchestration never deletes it).
 *      Surface the spawn outcome.
 */
export async function restartSession(
  uuid: string,
  mode: RestartMode,
  deps: RestartDeps,
): Promise<RestartOutcome> {
  // 1. Kill, sequenced by direct probes (AC7.2). Relaunch ONLY after confirmed-dead.
  const kill = await deps.confirmKilled();
  if (!kill.dead) {
    if (kill.reason === "kill-refused") {
      return { ok: false, reason: "kill-refused", rc: kill.rc };
    }
    return { ok: false, reason: "still-alive" };
  }

  // 2. The cwd both modes relaunch in — the dead session's own.
  const cwd = await deps.readBackCwd();
  if (cwd === undefined) return { ok: false, reason: "cwd-unreadable" };

  // 3. Relaunch by mode (AC7.3).
  const relaunchUuid = mode === "fresh" ? deps.newUuid() : uuid;
  let result: SpawnResult;
  try {
    result =
      mode === "fresh"
        ? await deps.issueFresh(relaunchUuid, cwd)
        : await deps.issueResume(relaunchUuid, cwd);
  } catch (err) {
    return {
      ok: false,
      reason: "spawn-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!result.ok) return { ok: false, reason: "spawn-failed", detail: result.reason };

  return {
    ok: true,
    mode,
    uuid: relaunchUuid,
    tmuxSession: result.tmuxSession,
    transcriptPath: result.transcriptPath,
  };
}
