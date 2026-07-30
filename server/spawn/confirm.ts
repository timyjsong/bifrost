/**
 * Constraint-safe spawn primitive — IMPURE executor. Issues the argv the pure layer
 * (./spawn.ts) built, through the user's shared tmux server, then confirms (or reaps) the
 * result. It makes NO security decision — every property was decided upstream; this
 * file only carries the plan out and observes disk/tmux.
 *
 * Red-team evidence this encodes (from the Build 2 red-team pass; the report
 * itself is not published — see `phases/02-start-restart.md` for why):
 *  - AC3.2 / spike-1: the spawn runs through the user's EXISTING tmux server (the default
 *    socket `/tmp/tmux-<uid>/default`), so the pane lands under the user session
 *    hierarchy (`user@<uid>.service/tmux-spawn-<uuid>.scope`) — never forked as a
 *    Bifrost child under system.slice/bifrost.service. We deliberately pass no
 *    `-L`/`-S` so tmux uses that shared default socket; bifrost.service runs as the
 *    same user, so a bare `tmux` connects to that user's server. cgroup rationale: a child
 *    forked by bifrost.service would inherit its 300 MiB cgroup; routing creation
 *    through the user tmux server puts the pane in the user slice instead.
 *  - M6: branch on `new-session`'s exit code FIRST. rc≠0 ⇒ name collision / launch
 *    refused — NO window or process was made (the losing racer runs no command), so
 *    it is safe; surface it, do NOT enter the confirm-poll. rc==0 ⇒ confirm-poll.
 *  - M7 / H6: confirm by claude's eager session file `<pid>.json` (under
 *    `<claudeDir>/sessions`) whose `sessionId` matches AND whose recorded `cwd`
 *    byte-equals the intended cwd, guarded by a /proc liveness check. NOT the
 *    transcript: claude writes `<uuid>.jsonl` only on the first turn, so a freshly
 *    originated idle session has none — the pid-file is written at boot (post-trust)
 *    and carries the cwd, giving the same identity guarantee, eager. On timeout, reap
 *    the pane so a half-spawn leaves no ghost.
 *  - Trust: claude blocks on a first-run trust prompt in any folder it hasn't trusted,
 *    writing no pid-file until answered. The confirm loop detects that prompt in the
 *    pane and answers it (Enter ⇒ "Yes, I trust this folder") so a folder the user picked
 *    proceeds; a miss falls through to the timeout, never a blind keypress.
 */
import { readFileSync } from "node:fs";
import { readdir, open } from "node:fs/promises";
import { join } from "node:path";

import { sessionName } from "./spawn";
import { pidMatchesStart, type LivePidRecord } from "./resume";

/** Run a tmux subcommand by argv, returning the exit code and stderr. Never throws
 *  on a non-zero exit — the spawn-confirm branch (M6) keys off the rc itself. */
async function tmuxRc(args: string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["tmux", ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const stderr = (await new Response(proc.stderr).text()).trim();
  return { code, stderr };
}

export type SpawnResult =
  | { ok: true; tmuxSession: string; transcriptPath: string }
  | { ok: false; reason: "collision"; stderr: string }
  | { ok: false; reason: "confirm-timeout" };

/**
 * The slug Claude derives for a project dir from a cwd: every `/` and `.` collapses
 * to `-` (verified against the on-disk `~/.claude/projects/` layout). LOSSY — two
 * distinct cwds (`a.b` vs `a-b`) share one slug dir (H6), which is exactly why the
 * confirm reads cwd back rather than trusting the slug.
 */
export function cwdSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Read the `cwd` recorded in the head of a `<uuid>.jsonl` transcript. Claude writes
 * a top-level `cwd` on its conversation entries; we scan the first lines until one
 * carries it. Returns undefined if the file has no cwd-bearing line yet (still booting)
 * or can't be read. Reads only a bounded head, never the whole (possibly huge) file.
 */
export async function readTranscriptCwd(path: string): Promise<string | undefined> {
  let head: string;
  try {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      head = buf.toString("utf8", 0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let d: { cwd?: unknown };
    try {
      d = JSON.parse(line);
    } catch {
      continue; // a partial trailing line; an earlier full line may still have cwd
    }
    if (typeof d.cwd === "string") return d.cwd;
  }
  return undefined;
}

/**
 * Confirm THIS spawn is live by claude's eager session file (M7/H6): scan
 * `<claudeDir>/sessions` for a `<pid>.json` whose `sessionId === uuid`, require its
 * recorded `cwd` to byte-equal the intended cwd (identity — a mismatch never confirms),
 * and verify the pid is still live via the procStart guard. Returns the live pid on a
 * confirmed match, undefined while still booting (no pid-file yet, or not yet live).
 * The pid-file is written at boot — unlike the transcript, which appears only on the
 * first turn — so this confirms a freshly-originated idle session. Readers injectable.
 */
export async function findConfirmedSession(
  sessionsDir: string,
  uuid: string,
  intendedCwd: string,
  io: {
    readDir?: (dir: string) => Promise<string[]>;
    readFile?: (path: string) => string;
    readStat?: (pid: number) => string;
  } = {},
): Promise<number | undefined> {
  const readDir = io.readDir ?? ((d) => readdir(d));
  const readFile = io.readFile ?? ((p) => readFileSync(p, "utf8"));
  let files: string[];
  try {
    files = await readDir(sessionsDir);
  } catch {
    return undefined; // sessions dir not present yet — still booting
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let rec: LivePidRecord;
    try {
      rec = JSON.parse(readFile(join(sessionsDir, f))) as LivePidRecord;
    } catch {
      continue; // unreadable/partial pid file — an earlier full record may still match
    }
    if (!rec.pid || rec.sessionId !== uuid) continue; // not this spawn's session
    if (rec.cwd !== intendedCwd) return undefined; // identity mismatch — never confirm (M7/H6)
    if (pidMatchesStart(rec.pid, rec.procStart, io.readStat)) return rec.pid; // live ⇒ confirmed
    return undefined; // pid-file present but pid not (yet) live — keep polling
  }
  return undefined; // no pid-file names this uuid yet — still booting
}

/** Where claude WILL write this session's transcript (`<slug>/<uuid>.jsonl`) once its
 *  first turn lands. issueSpawn returns it for callers that record the path; the file
 *  need not exist yet — a fresh idle session has none until it is driven. */
export function eventualTranscriptPath(
  projectsDir: string,
  uuid: string,
  cwd: string,
): string {
  return join(projectsDir, cwdSlug(cwd), `${uuid}.jsonl`);
}

/**
 * Detect claude's first-run trust prompt. Claude blocks here on any folder it hasn't
 * trusted, writing no pid-file until it's answered. Matched on the stable prompt
 * phrasing (either marker line); a miss leaves the loop to time out rather than press
 * a key blind. Pure — the confirm loop owns the keypress.
 */
export function isTrustPrompt(paneText: string): boolean {
  return /Is this a project you created or one you trust|Yes, I trust this folder/i.test(
    paneText,
  );
}

/** Read a pane's visible text (`tmux capture-pane -p`). Empty string on any failure. */
async function capturePane(tmuxSession: string): Promise<string> {
  try {
    const proc = Bun.spawn(["tmux", "capture-pane", "-t", tmuxSession, "-p"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    await proc.exited;
    return await new Response(proc.stdout).text();
  } catch {
    return "";
  }
}

/** Default trust handler: if the pane is sitting at claude's first-run trust prompt,
 *  answer it (Enter ⇒ "Yes, I trust this folder"). A no-op otherwise, so an
 *  already-trusted folder is never sent a stray keypress. */
async function answerTrustIfPrompted(tmuxSession: string): Promise<void> {
  if (isTrustPrompt(await capturePane(tmuxSession))) {
    await tmuxRc(["send-keys", "-t", tmuxSession, "Enter"]);
  }
}

export interface ConfirmDeps {
  /** `<claudeDir>/projects` — only to compute the eventual transcript path. */
  projectsDir: string;
  /** `<claudeDir>/sessions` — the eager `<pid>.json` files the confirm reads. */
  sessionsDir: string;
  /** Polling budget. */
  timeoutMs: number;
  /** Poll interval. */
  pollMs?: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /** Injectable sleep for deterministic tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Resolve the confirmed live pid for (uuid, cwd), or undefined while still booting.
   *  Defaults to findConfirmedSession over the real sessions dir. */
  confirm?: (uuid: string, intendedCwd: string) => Promise<number | undefined>;
  /** Per-poll trust handler — answers the first-run trust prompt if shown. Defaults to
   *  capture-pane + send-keys Enter; injected as a no-op in tests. */
  handleTrust?: (tmuxSession: string) => Promise<void>;
}

/**
 * Issue an already-built spawn argv and resolve its outcome. The argv MUST be the
 * output of buildSpawnArgv/buildResumeArgv (model-validated, no-headless-asserted);
 * this executor does not re-derive it. Branches on the `new-session` rc (M6), then on
 * rc==0 polls findConfirmedSession (claude's eager pid-file, identity-checked) until
 * the session confirms or the budget elapses — answering the first-run trust prompt
 * along the way. On timeout, reaps the pane (kill-session) so no half-spawn lingers.
 */
export async function issueSpawn(
  argv: string[],
  uuid: string,
  intendedCwd: string,
  deps: ConfirmDeps,
): Promise<SpawnResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 250;
  const confirm =
    deps.confirm ?? ((id, cwd) => findConfirmedSession(deps.sessionsDir, id, cwd));
  const handleTrust = deps.handleTrust ?? answerTrustIfPrompted;
  const name = sessionName(uuid);

  // argv[0] is the literal "tmux"; Bun.spawn takes the binary as argv[0].
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  const stderr = (await new Response(proc.stderr).text()).trim();

  // M6: rc≠0 ⇒ collision / launch-refused. No window/process was made, so nothing to
  // reap and nothing to confirm — surface and stop. NEVER enter the confirm-poll.
  if (code !== 0) {
    return { ok: false, reason: "collision", stderr };
  }

  // rc==0 ⇒ the pane exists. Confirm via the eager pid-file (sessionId + cwd identity),
  // answering claude's first-run trust prompt if it's blocked on one.
  const deadline = now() + deps.timeoutMs;
  while (now() < deadline) {
    const pid = await confirm(uuid, intendedCwd);
    if (pid !== undefined) {
      return {
        ok: true,
        tmuxSession: name,
        transcriptPath: eventualTranscriptPath(deps.projectsDir, uuid, intendedCwd),
      };
    }
    await handleTrust(name); // answer the trust prompt if the pane is sitting at it
    await sleep(pollMs);
  }

  // Timed out: reap the pane so a half-spawn (window made, claude died on a bad
  // flag/auth, or never got past trust) leaves no orphan session behind.
  await tmuxRc(["kill-session", "-t", name]);
  return { ok: false, reason: "confirm-timeout" };
}
