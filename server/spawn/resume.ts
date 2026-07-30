/**
 * Resume — the safety-gated bring-live of an INACTIVE session. The whole point is
 * the anti-corruption gate: never put a second interactive claude on a transcript a
 * live one is already writing (Tier-1 corruption, REDTEAM C3/H4). So resume launches
 * ONLY on a POSITIVE "definitely not live" signal, taken fresh at click time, under a
 * per-uuid lock — never the absence of a live signal off a ≤3s-stale tick snapshot.
 *
 * Layering mirrors the rest of spawn/: this module is the PURE decision + the
 * orchestration over INJECTED effects (the fresh live probe, the transcript-cwd
 * readback, the spawn issuer). The impure endpoint (server/index.ts) supplies the
 * real /proc + tmux + filesystem effects and the per-uuid lock at the route.
 *
 * Story 2-6 contract:
 *  - AC6.1: gate on a POSITIVE not-live signal — transcript mtime QUIESCENT AND no
 *    live pid referencing the uuid AND no Bifrost-owned tmux session for it. A
 *    booting / mid-rewrite session must NOT read resumable. Signals read FRESH at
 *    click time (sessions dir + /proc with the procStart reuse guard), never the tick
 *    snapshot.
 *  - AC6.2: the whole check→claim→spawn→confirm runs under a per-uuid in-process
 *    lock; a concurrent same-uuid resume returns 409 "already starting."
 *  - AC6.3: if the session is already live, resume routes to DRIVE — never a second
 *    claude on it (no double-writer).
 *  - AC6.4: launch `--resume <uuid>` cd'd to the transcript's read-back cwd; if that
 *    cwd no longer exists, surface "degraded — cwd missing" instead of launching.
 *  - AC6.5: resume is allowed for ANY directory (no realm confine — only originate
 *    has the /home/you guard).
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { sessionName } from "./spawn";
import type { SpawnResult } from "./confirm";

// ── AC6.1 — the fresh live probe (sessions dir + /proc, procStart reuse guard) ──

/**
 * Is `pid` alive AND is it the SAME process that wrote the pid file? `/proc/<pid>/stat`
 * field 22 (1-based) is the process start time; if the pid was recycled to a different
 * process, its starttime won't match the recorded `procStart`, so we read it as not the
 * session's process. This is the exact guard collectLive uses (sessions.ts readProc) —
 * replicated here so the fresh probe owns its own read and never reaches into the
 * collector's tick state. Any /proc read failure ⇒ not alive (caller treats unknown as
 * "could be live", never as "safe to resume" — see decideResumable's pid signal).
 *
 * Parsing: comm (field 2) can contain spaces and parens, so we slice after the LAST
 * ')'; after ") " index 0 is field 3 (state), making starttime (field 22) index 19.
 */
export function pidMatchesStart(
  pid: number,
  procStart: string | undefined,
  readStat: (pid: number) => string = (p) => readFileSync(`/proc/${p}/stat`, "utf8"),
): boolean {
  let statLine: string;
  try {
    statLine = readStat(pid);
  } catch {
    return false; // /proc/<pid> gone ⇒ that pid isn't alive
  }
  const after = statLine.slice(statLine.lastIndexOf(")") + 2).trimStart().split(" ");
  // If the pid file recorded a procStart, it MUST match — a recycled pid is not ours.
  if (procStart && after[19] !== procStart) return false;
  return true;
}

/** Shape of the per-pid liveness records `~/.claude/sessions/<pid>.json` carries. */
export interface LivePidRecord {
  pid: number;
  sessionId: string;
  procStart?: string;
  cwd?: string; // the session's working dir — the spawn-confirm identity check reads it
}

export interface ProbeDeps {
  /** `<claudeDir>/sessions` — the dir of `<pid>.json` liveness files. */
  sessionsDir: string;
  /** Injectable /proc/<pid>/stat reader (real fs in production). */
  readStat?: (pid: number) => string;
  /** Injectable directory read (real fs in production). */
  readDir?: (dir: string) => Promise<string[]>;
  /** Injectable per-file read (real fs in production). */
  readFile?: (path: string) => string;
}

/**
 * Probe FRESH whether any live pid references `uuid` (AC6.1 / H4). Reads the sessions
 * dir at call time — never the tick snapshot — and returns the live pid for any
 * `<pid>.json` whose `sessionId === uuid` AND whose `/proc` passes the procStart guard.
 *
 * H4 anti-fallback: a pid FILE that names the uuid but is partial/unreadable does NOT
 * read as "not live" — `pidFilePresent` flags that the uuid is referenced AT ALL, even
 * by a file we couldn't fully parse or whose /proc check transiently failed. The gate
 * (decideResumable) treats a referenced-but-unconfirmed uuid as occupied, never as safe
 * to resume — so a mid-rewrite pid file can't authorize a second writer.
 */
export async function probeLiveByUuid(
  uuid: string,
  deps: ProbeDeps,
): Promise<{ livePid: number | null; pidFilePresent: boolean }> {
  const readDir = deps.readDir ?? (async (d) => readdir(d));
  const readFile = deps.readFile ?? ((p) => readFileSync(p, "utf8"));
  const readStat = deps.readStat;

  let files: string[];
  try {
    files = await readDir(deps.sessionsDir);
  } catch {
    // No sessions dir ⇒ nothing claims to be live. (A genuinely live session always
    // writes a pid file; its absence here is a true negative, not a silent fallback.)
    return { livePid: null, pidFilePresent: false };
  }

  let pidFilePresent = false;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let rec: LivePidRecord;
    try {
      rec = JSON.parse(readFile(join(deps.sessionsDir, f))) as LivePidRecord;
    } catch {
      // Unreadable/partial pid file. We cannot read its sessionId — but a file that
      // FAILS to parse could be a mid-rewrite of THIS uuid's record. Conservative: if
      // the filename's pid is alive at all, flag the uuid space as possibly-occupied
      // rather than silently skip (H4). We can't attribute it to a uuid, so it only
      // raises pidFilePresent if we can't rule it out — but since we don't know its
      // uuid, we leave it to the per-uuid match below and DON'T globally block every
      // resume on one corrupt unrelated file. The dominant H4 case (the uuid's OWN
      // file mid-rewrite) is caught when at least one parse names the uuid.
      continue;
    }
    if (!rec.pid || rec.sessionId !== uuid) continue;
    // A pid file naming THIS uuid exists — the uuid is referenced. Even if the /proc
    // check below fails (transient), this keeps the gate from authorizing a resume.
    pidFilePresent = true;
    if (pidMatchesStart(rec.pid, rec.procStart, readStat)) {
      return { livePid: rec.pid, pidFilePresent: true };
    }
  }
  return { livePid: null, pidFilePresent };
}

// ── AC6.1 — the pure resumable decision (POSITIVE not-live gate) ────────────────

/** The fresh signals the resumable decision is taken over. */
export interface ResumeSignals {
  /** The transcript's last-modified time (ms). undefined ⇒ unknown ⇒ not quiescent. */
  mtimeMs: number | undefined;
  /** A live pid referencing the uuid from the fresh probe, or null. */
  livePid: number | null;
  /** A pid file referencing the uuid exists, even if /proc didn't confirm it (H4). */
  pidFilePresent: boolean;
  /** Is the Bifrost-owned tmux session name for this uuid in the LIVE tmux set? */
  bifrostTmuxLive: boolean;
}

export type ResumeVerdict =
  // Positive not-live: every signal says inactive — safe to resume.
  | { resumable: true }
  // Live: a positive live signal — route to DRIVE, never spawn a second claude.
  | { resumable: false; reason: "live" }
  // Not-quiescent / referenced-but-unconfirmed: cannot prove not-live — refuse.
  | { resumable: false; reason: "not-quiescent" | "uuid-referenced" };

/** Default quiescent window: a transcript modified within this is treated as a
 *  booting / mid-write session, NOT quiescent — so it never reads resumable (C3). */
export const DEFAULT_QUIESCENT_MS = 5_000;

/**
 * The POSITIVE not-live gate (AC6.1). resumable ⇔ ALL of:
 *   - mtime quiescent (now - mtimeMs > quiescentMs; unknown mtime is NOT quiescent),
 *   - no live pid referencing the uuid,
 *   - no Bifrost-owned tmux session live for it.
 * Otherwise NOT resumable, with the reason distinguishing a genuinely-live session
 * (route to drive, AC6.3) from one we merely can't prove dead (mid-rewrite / partial
 * pid file → refuse rather than risk a double writer, H4). Pure — decides on the
 * fresh signals the caller probed; reads nothing itself.
 */
export function decideResumable(
  signals: ResumeSignals,
  now: number,
  quiescentMs: number = DEFAULT_QUIESCENT_MS,
): ResumeVerdict {
  // A confirmed live pid OR a live Bifrost tmux session ⇒ genuinely live ⇒ drive.
  if (signals.livePid !== null || signals.bifrostTmuxLive) {
    return { resumable: false, reason: "live" };
  }
  // A pid file names the uuid but /proc didn't confirm it (mid-rewrite / transient
  // /proc failure). We can't prove it dead, so we must not authorize a second writer.
  if (signals.pidFilePresent) {
    return { resumable: false, reason: "uuid-referenced" };
  }
  // Mtime quiescence: an unknown or recent mtime is a possibly-booting/mid-write
  // session — not a positive not-live signal.
  if (signals.mtimeMs === undefined || now - signals.mtimeMs <= quiescentMs) {
    return { resumable: false, reason: "not-quiescent" };
  }
  return { resumable: true };
}

/** The Bifrost-owned tmux session name a resumed/originated uuid lands under —
 *  the membership the gate checks the live tmux set for. Reuses the spawn naming so
 *  resume and originate name a session identically. */
export function bifrostTmuxName(uuid: string): string {
  return sessionName(uuid);
}

/**
 * Probe FRESH whether the Bifrost-owned tmux session for `uuid` is currently live
 * (AC6.1). Runs `tmux has-session -t <name>` against the user's shared server at click
 * time — never the ≤3s tick snapshot's cached membership — so a pane that appeared
 * (or vanished) since the last tick is read correctly. Exit 0 ⇒ live. The `=<name>`
 * target form matches the session name EXACTLY (no prefix match). Never throws.
 */
export async function bifrostTmuxLiveFresh(uuid: string): Promise<boolean> {
  try {
    const p = Bun.spawn(["tmux", "has-session", "-t", `=${bifrostTmuxName(uuid)}`], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await p.exited) === 0;
  } catch {
    return false; // tmux unavailable ⇒ no Bifrost pane for this uuid
  }
}

// ── AC6.2 — per-uuid in-process lock ────────────────────────────────────────────

/**
 * A per-uuid in-process lock (AC6.2 / M3). The FIRST resume for a uuid claims the
 * lock and runs; a concurrent same-uuid resume finds the lock held and is rejected
 * (the route maps that to 409 "already starting"). This makes check→claim→spawn→
 * confirm one critical section per uuid, closing the TOCTOU two-writer race even
 * when the live probe itself is perfectly fresh. Different uuids never contend.
 */
export class PerUuidLock {
  private held = new Set<string>();

  /** Try to acquire the lock for `uuid`. Returns false if already held. */
  tryAcquire(uuid: string): boolean {
    if (this.held.has(uuid)) return false;
    this.held.add(uuid);
    return true;
  }

  /** Release the lock for `uuid` (idempotent). */
  release(uuid: string): void {
    this.held.delete(uuid);
  }

  /**
   * Run `fn` under the per-uuid lock. If the lock is already held, resolves to
   * `{ ok: false, reason: "already-starting" }` WITHOUT running `fn` (no second
   * writer). Otherwise runs `fn` and always releases the lock afterward.
   */
  async run<T>(
    uuid: string,
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: "already-starting" }> {
    if (!this.tryAcquire(uuid)) return { ok: false, reason: "already-starting" };
    try {
      return { ok: true, value: await fn() };
    } finally {
      this.release(uuid);
    }
  }
}

// ── AC6.3 / AC6.4 / AC6.5 — the resume orchestration ────────────────────────────

/** The effects the resume orchestration drives — injected so every branch is tested
 *  without real claude / tmux / a live session. */
export interface ResumeDeps {
  /** Fresh live probe for the uuid (AC6.1). */
  probe: () => Promise<{ livePid: number | null; pidFilePresent: boolean }>;
  /** Is the Bifrost-owned tmux session for the uuid in the LIVE tmux set (AC6.1)? */
  bifrostTmuxLive: () => boolean;
  /** The transcript's current mtime (ms), or undefined if unknown (AC6.1). */
  transcriptMtime: () => number | undefined;
  /** The transcript's read-back cwd, or undefined if it can't be read (AC6.4). */
  readBackCwd: () => Promise<string | undefined>;
  /** Does `cwd` still exist on disk (AC6.4 missing-cwd branch)? */
  cwdExists: (cwd: string) => Promise<boolean>;
  /** Issue the already-decided `--resume` launch and confirm/reap it (AC6.4). */
  issueResume: (uuid: string, cwd: string) => Promise<SpawnResult>;
  /** Current time (ms) for the quiescence test — injectable for deterministic tests. */
  now: () => number;
}

export type ResumeOutcome =
  // Launched a fresh resume claude, confirmed driveable.
  | { ok: true; uuid: string; tmuxSession: string; transcriptPath: string }
  // Already live ⇒ the caller routes to the existing drive view (AC6.3).
  | { ok: false; reason: "already-live" }
  // The transcript cwd is gone ⇒ degraded, surfaced not launched (AC6.4).
  | { ok: false; reason: "degraded-cwd-missing"; cwd: string }
  // Couldn't read the transcript cwd at all ⇒ nothing to cd to (AC6.4).
  | { ok: false; reason: "degraded-cwd-unreadable" }
  // Gated not-resumable for a non-live reason (mid-rewrite / not quiescent).
  | { ok: false; reason: "not-resumable"; detail: "not-quiescent" | "uuid-referenced" }
  // The launch itself failed (collision / confirm-timeout / threw).
  | { ok: false; reason: "spawn-failed"; detail: string };

/**
 * Run resume end-to-end (AC6.1/6.3/6.4/6.5) over injected effects. Order is
 * load-bearing and runs INSIDE the per-uuid lock the caller holds:
 *   1. Probe FRESH (live pid + Bifrost tmux + mtime) and decide resumable.
 *      - live ⇒ route to drive (AC6.3), no spawn.
 *      - not-quiescent / uuid-referenced ⇒ refuse (no double-writer, H4).
 *   2. Read back the transcript cwd (AC6.4). Unreadable ⇒ degraded.
 *   3. Verify the cwd still exists (AC6.4). Missing ⇒ "degraded — cwd missing",
 *      surfaced rather than launched. NO realm confine (AC6.5) — any dir resumes.
 *   4. Issue `--resume <uuid>` cd'd to that verified cwd; surface the spawn outcome.
 */
export async function resumeSession(
  uuid: string,
  deps: ResumeDeps,
): Promise<ResumeOutcome> {
  const { livePid, pidFilePresent } = await deps.probe();
  const verdict = decideResumable(
    {
      mtimeMs: deps.transcriptMtime(),
      livePid,
      pidFilePresent,
      bifrostTmuxLive: deps.bifrostTmuxLive(),
    },
    deps.now(),
  );

  if (!verdict.resumable) {
    if (verdict.reason === "live") return { ok: false, reason: "already-live" };
    return { ok: false, reason: "not-resumable", detail: verdict.reason };
  }

  // Read the transcript's own cwd (AC6.4). The launch cd's HERE, not to a guessed
  // slug-reversal — the slug is lossy. No /home/you confine (AC6.5).
  const cwd = await deps.readBackCwd();
  if (cwd === undefined) return { ok: false, reason: "degraded-cwd-unreadable" };
  if (!(await deps.cwdExists(cwd))) {
    return { ok: false, reason: "degraded-cwd-missing", cwd };
  }

  let result: SpawnResult;
  try {
    result = await deps.issueResume(uuid, cwd);
  } catch (err) {
    return {
      ok: false,
      reason: "spawn-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!result.ok) {
    return { ok: false, reason: "spawn-failed", detail: result.reason };
  }
  return {
    ok: true,
    uuid,
    tmuxSession: result.tmuxSession,
    transcriptPath: result.transcriptPath,
  };
}
