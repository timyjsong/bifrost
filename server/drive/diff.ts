/**
 * Session diff — the review spine (GOAL A, the mobile app's diff-badge →
 * tap → review pattern). V1 contract: the CUMULATIVE uncommitted diff of the
 * session's cwd (working tree vs HEAD) — what you'd review before letting a
 * session's work stand. Per-turn diffs need checkpoint bookkeeping and wait
 * for a later cycle. Read-only git, cwd comes from the session record
 * server-side (the client sends only a session id — no path surface), output
 * capped so a huge diff can't flood the transport.
 */

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

export type SessionDiff =
  | { git: false }
  | { git: true; stat: DiffStat; diff: string; truncated: boolean };

/** Parse `git diff --shortstat` ("3 files changed, 10 insertions(+), 2 deletions(-)"). */
export function parseShortstat(text: string): DiffStat {
  const files = /(\d+) files? changed/.exec(text);
  const ins = /(\d+) insertions?\(\+\)/.exec(text);
  const del = /(\d+) deletions?\(-\)/.exec(text);
  return {
    files: files ? Number(files[1]) : 0,
    insertions: ins ? Number(ins[1]) : 0,
    deletions: del ? Number(del[1]) : 0,
  };
}

export const DIFF_BYTE_CAP = 200_000;

/**
 * The working-tree diff for a cwd. `run` is injectable (argv-style, never a
 * shell). Untracked files are included via intent-to-add-less `--no-index`?
 * No — v1 sticks to tracked changes (`git diff HEAD`): the honest "what did
 * the session change in code I version" read.
 */
export async function sessionDiff(
  cwd: string,
  run: (argv: string[], cwd: string) => Promise<{ code: number; stdout: string }>,
): Promise<SessionDiff> {
  const probe = await run(["git", "rev-parse", "--is-inside-work-tree"], cwd);
  if (probe.code !== 0 || !probe.stdout.trim().startsWith("true")) return { git: false };
  const [stat, diff] = await Promise.all([
    run(["git", "diff", "HEAD", "--shortstat"], cwd),
    run(["git", "diff", "HEAD"], cwd),
  ]);
  const full = diff.stdout;
  const truncated = full.length > DIFF_BYTE_CAP;
  return {
    git: true,
    stat: parseShortstat(stat.stdout),
    diff: truncated ? full.slice(0, DIFF_BYTE_CAP) : full,
    truncated,
  };
}
