/**
 * Constraint-safe spawn primitive — PURE layer. This is the RCE-by-design surface
 * (the security floor for originating a fresh interactive claude), so every safety
 * property lives here as a tested, side-effect-free decision; the executor
 * (./confirm.ts) is a thin shell that only carries out an already-validated plan.
 *
 * Red-team evidence this encodes (phases/02-REDTEAM.md):
 *  - C1: bifrost.service's PATH has no ~/.local/bin, so a bare `claude` in a spawned
 *    pane dies "command not found" 100% of the time. The binary is referenced by
 *    ABSOLUTE PATH, resolved at build time, with a pre-spawn existence assertion.
 *  - H5 / spike-3: the tmux `<group>-<n>` suffix is tmux's server-global session id,
 *    not Bifrost's to allocate. We name the session with a Bifrost-owned uuid token
 *    (`bifrost-spawn-<uuid8>`); the uuid carries all correctness weight (`--session-id`).
 *  - AC3.6: the built argv NEVER contains `-p`/`--print`/headless/SDK forms — the
 *    product invokes claude ONLY as an interactive `tmux new-session … <abs claude> …`
 *    launch (hard CLAUDE.md billing constraint). A guard re-asserts this on every build.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { confinePath, type ConfineResult } from "../files/confine";
import { SPAWN_MODELS } from "../../shared/types";

/**
 * The claude binary, by absolute path. A spawned pane inherits the issuing client's
 * (bifrost.service's) minimal systemd PATH, which lacks ~/.local/bin — so a bare
 * `claude` is unresolvable in the pane (C1). The launch must name the binary outright.
 * This is the last-resort default (the standard per-user install location, whoever
 * the user is); cfg.claudeBin overrides it at every call site.
 */
export const CLAUDE_BIN = join(homedir(), ".local/bin/claude");

/**
 * The `--model` allowlist: the four pickable models, by their claude CLI alias
 * (verified against `claude --help`: an alias names the latest model in a family).
 *   opus   → Opus 4.8
 *   sonnet → Sonnet 4.6
 *   haiku  → Haiku
 *   fable  → Fable 5
 * A non-allowlisted model is rejected BEFORE launch — the spawn never reaches tmux.
 */
export const MODEL_ALLOWLIST = SPAWN_MODELS.map((m) => m.alias);
export type AllowedModel = (typeof SPAWN_MODELS)[number]["alias"];

export function isAllowedModel(model: string): model is AllowedModel {
  return (MODEL_ALLOWLIST as readonly string[]).includes(model);
}

/**
 * Forms that would make the launch headless / SDK / programmatic — forbidden by the
 * hard CLAUDE.md billing constraint. The argv guard rejects any of these appearing
 * anywhere in the built command, so a future edit can't silently smuggle one in.
 */
const FORBIDDEN_ARGS = ["-p", "--print", "--headless", "--sdk", "--agent"] as const;

/**
 * The Bifrost-owned tmux session name for a spawn: `bifrost-spawn-<uuid8>`, where
 * <uuid8> is the first 8 hex chars of the session uuid. Never a guessed integer
 * (the tmux numeric suffix is tmux's to allocate, not ours — H5). The uuid8 is
 * cosmetic only; correctness rests on `--session-id <uuid>` + exact live-set membership.
 */
export function sessionName(uuid: string): string {
  const uuid8 = uuid.replace(/-/g, "").slice(0, 8);
  if (uuid8.length !== 8) throw new Error(`spawn: malformed uuid ${JSON.stringify(uuid)}`);
  return `bifrost-spawn-${uuid8}`;
}

/**
 * Pre-spawn assertion: the resolved claude binary must exist on disk, or the launch
 * fails LOUDLY here — before any tmux session is created — rather than becoming a
 * half-spawn the reap path has to clean up (C1). Injectable existence check for tests.
 */
export function assertBinaryExists(
  binPath: string = CLAUDE_BIN,
  exists: (p: string) => boolean = existsSync,
): void {
  if (!exists(binPath)) {
    throw new Error(`spawn: claude binary not found at ${binPath} (pre-spawn assertion)`);
  }
}

export interface SpawnPlan {
  /** The session uuid to pin (`--session-id`). Also seeds the tmux session name. */
  uuid: string;
  /** The model alias — must be on MODEL_ALLOWLIST. */
  model: string;
  /** The working directory — must be confined under /home/you (validate separately). */
  cwd: string;
  /** Absolute claude binary path. Defaults to CLAUDE_BIN. */
  claudeBin?: string;
}

/**
 * Build the `tmux new-session` launch as ARGV (execFile-style) — never a shell
 * string, so no payload can ever reach a shell to be interpreted. Validates the
 * model against the allowlist and re-asserts the no-headless property on the
 * finished argv. The cwd is confined SEPARATELY (confineSpawnCwd) before calling
 * this; the value lands in argv as `-c <cwd>`, untouched by any shell.
 *
 * Shape (AC3.6): tmux new-session -d -s <name> -c <cwd> <abs claude> --session-id <uuid> --model <m>
 */
export function buildSpawnArgv(plan: SpawnPlan): string[] {
  if (!isAllowedModel(plan.model)) {
    throw new Error(
      `spawn: model ${JSON.stringify(plan.model)} not on allowlist [${MODEL_ALLOWLIST.join(", ")}]`,
    );
  }
  const bin = plan.claudeBin ?? CLAUDE_BIN;
  const name = sessionName(plan.uuid);

  const argv = [
    "tmux",
    "new-session",
    "-d", // detached: create the session without attaching this (server) client
    // A detached pane defaults to 80x24 — too narrow for the TUI's status bar,
    // which drops "esc to interrupt" (and other literal-keyed chrome) at that
    // width, silently breaking the working/mode signals for every spawned
    // session. Size it like a real terminal so the chrome renders in full.
    "-x",
    "220",
    "-y",
    "50",
    "-s",
    name,
    "-c",
    plan.cwd,
    bin,
    "--session-id",
    plan.uuid,
    "--model",
    plan.model,
  ];

  assertNoHeadless(argv);
  return argv;
}

export interface ResumePlan {
  /** The session uuid to resume (`--resume`). Also seeds the tmux session name. */
  uuid: string;
  /** The working directory — the transcript's verified read-back cwd. NOT confined
   *  to /home/you: resume is allowed for any directory (AC6.5), so the cwd is the
   *  session's own, taken as-is. */
  cwd: string;
  /** Absolute claude binary path. Defaults to CLAUDE_BIN. */
  claudeBin?: string;
}

/**
 * Build the `tmux new-session` resume launch as ARGV (execFile-style). Unlike a
 * fresh spawn this carries NO `--model` (resume restores the session's own model)
 * and pins the uuid with `--resume <uuid>`. The cwd lands in argv as `-c <cwd>`,
 * untouched by any shell; it is NOT confined to /home/you (AC6.5 — resume is
 * allowed for any directory; only originate carries the /home/you guard). The cwd's
 * existence is checked SEPARATELY by the caller (AC6.4 missing-cwd branch) before
 * this runs — this builder makes no filesystem decision.
 *
 * Shape (AC3.6/AC6.4): tmux new-session -d -s <name> -c <cwd> <abs claude> --resume <uuid>
 */
export function buildResumeArgv(plan: ResumePlan): string[] {
  const bin = plan.claudeBin ?? CLAUDE_BIN;
  const name = sessionName(plan.uuid);

  const argv = [
    "tmux",
    "new-session",
    "-d", // detached: create the session without attaching this (server) client
    // A detached pane defaults to 80x24 — too narrow for the TUI's status bar,
    // which drops "esc to interrupt" (and other literal-keyed chrome) at that
    // width, silently breaking the working/mode signals for every spawned
    // session. Size it like a real terminal so the chrome renders in full.
    "-x",
    "220",
    "-y",
    "50",
    "-s",
    name,
    "-c",
    plan.cwd,
    bin,
    "--resume",
    plan.uuid,
  ];

  assertNoHeadless(argv);
  return argv;
}

/**
 * Guard: the built argv must reference claude ONLY in the interactive launch shape
 * and must carry none of the headless/SDK forms. Throws if a forbidden flag appears
 * or if the launch isn't `tmux new-session … <claude> [--session-id|--resume] …`.
 * Belt-and-suspenders for the hard billing constraint — runs on every build.
 */
export function assertNoHeadless(argv: string[]): void {
  for (const arg of argv) {
    if ((FORBIDDEN_ARGS as readonly string[]).includes(arg)) {
      throw new Error(`spawn: forbidden headless/SDK arg ${JSON.stringify(arg)} in launch argv`);
    }
  }
  if (argv[0] !== "tmux" || argv[1] !== "new-session") {
    throw new Error("spawn: launch argv must be a `tmux new-session` command");
  }
  const binIdx = argv.findIndex((a) => a.endsWith("/claude"));
  if (binIdx === -1) {
    throw new Error("spawn: launch argv must reference the absolute claude binary");
  }
  // The token right after the binary must be a recognized interactive launch flag.
  const launchFlag = argv[binIdx + 1];
  if (launchFlag !== "--session-id" && launchFlag !== "--resume") {
    throw new Error(
      `spawn: claude must launch with --session-id or --resume, got ${JSON.stringify(launchFlag)}`,
    );
  }
}

/**
 * Confine a start-fresh cwd to under /home/you (AC3.4) by reusing the file-browser's
 * canonicalizing confinement (./files/confine.ts) — symlink- and `..`-resolved, so a
 * symlink or `..` escape can't smuggle a cwd outside the home boundary. The cwd is
 * the one user-supplied input that picks WHERE a promptable claude runs, so it carries
 * the same RCE weight the read-only browser guards; it gets the same chokepoint.
 */
export function confineSpawnCwd(
  cwd: string,
  root: string = homedir(),
  realpath?: (p: string) => Promise<string>,
): Promise<ConfineResult> {
  return realpath
    ? confinePath(cwd, [root], realpath)
    : confinePath(cwd, [root]);
}
