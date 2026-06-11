import { existsSync, readFileSync } from "node:fs";
import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectInfo, ProjectGit, SessionInfo } from "../../shared/types";
import type { AtriumConfig } from "../config";

async function run(cmd: string[], timeoutMs = 5000): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    return (await proc.exited) === 0 ? out : null;
  } catch {
    return null;
  }
}

async function gitInfo(path: string): Promise<ProjectGit | undefined> {
  if (!existsSync(join(path, ".git"))) return undefined;

  let branch: string | null = null;
  try {
    const head = readFileSync(join(path, ".git", "HEAD"), "utf8").trim();
    branch = head.startsWith("ref: refs/heads/")
      ? head.slice("ref: refs/heads/".length)
      : head.slice(0, 8); // detached
  } catch {
    // .git may be a gitfile pointer (worktree/submodule) — ask git itself
    const out = await run(["git", "-C", path, "rev-parse", "--abbrev-ref", "HEAD"]);
    branch = out?.trim() || null;
  }

  const log = await run([
    "git", "-C", path, "log", "-1", "--format=%ct\t%s",
  ]);
  if (branch === null && log === null) return undefined; // broken gitfile — not a usable repo
  let lastCommitAt = 0;
  let lastCommitMsg = "";
  if (log) {
    const [ct, ...rest] = log.trim().split("\t");
    lastCommitAt = Number(ct) * 1000 || 0;
    lastCommitMsg = rest.join("\t");
  }

  const status = await run(["git", "-C", path, "status", "--porcelain"]);
  const dirty = status ? status.split("\n").filter(Boolean).length : 0;

  return { branch: branch ?? "?", dirty, lastCommitMsg, lastCommitAt };
}

async function readBlurb(path: string): Promise<string | undefined> {
  for (const name of ["README.md", "readme.md", "README"]) {
    const p = join(path, name);
    if (!existsSync(p)) continue;
    try {
      const text = (await readFile(p, "utf8")).slice(0, 4096);
      for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || line.startsWith("![") || line.startsWith(">") || line.startsWith("---")) continue;
        const clean = line
          .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/[*_`]/g, "")
          .trim();
        if (clean) return clean.length > 180 ? clean.slice(0, 177) + "…" : clean;
      }
    } catch {
      // unreadable README
    }
  }
  return undefined;
}

export async function collectProjects(
  cfg: AtriumConfig,
  sessions: SessionInfo[],
): Promise<ProjectInfo[]> {
  const out: ProjectInfo[] = [];
  for (const realm of cfg.realms) {
    let entries;
    try {
      entries = await readdir(realm.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const path = join(realm.path, e.name);
      const [git, blurb, dirStat] = await Promise.all([
        gitInfo(path),
        readBlurb(path),
        stat(path).catch(() => null),
      ]);

      const inProject = (cwd: string) =>
        cwd === path || cwd.startsWith(path + "/");
      const projSessions = sessions.filter((s) => s.cwd && inProject(s.cwd));
      const liveSessions = projSessions.filter((s) => s.live).length;
      const sessionActivity = projSessions.reduce(
        (m, s) => Math.max(m, s.lastActivityAt),
        0,
      );

      out.push({
        name: e.name,
        realm: realm.name,
        path,
        blurb,
        git,
        lastActivityAt: Math.max(
          git?.lastCommitAt ?? 0,
          dirStat?.mtimeMs ?? 0,
          sessionActivity,
        ),
        liveSessions,
        recentSessions: projSessions.length,
      });
    }
  }
  out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return out;
}
