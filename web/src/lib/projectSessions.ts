/**
 * Pure data shaping for the project-centric resumeable list (story 2-2, AC2.1).
 *
 * Sessions render nested under their project: each project gets its active
 * (tmux-resident) sessions and its recent (dead, within-historyDays) ones. The
 * collector already capped the snapshot to active + recent (+ pinned rescues),
 * so this layer only buckets the rendered list by project and orders it — it
 * does NOT re-derive the cutoff (that is the server's job, story 2-1).
 *
 * No React, no I/O — unit-tested directly, so the view stays a thin renderer.
 */
import type { ProjectInfo, SessionInfo } from "../../../shared/types";

/** A project with its sessions split into active (live) and recent (dead). */
export interface ProjectSessionGroup {
  project: ProjectInfo;
  active: SessionInfo[]; // live, tmux-resident — route to the drive view
  recent: SessionInfo[]; // dead, within historyDays — open view-only
}

/**
 * The project a session belongs to: the project whose `path` is the session's
 * `cwd` or a prefix of it, longest (most specific) path winning when a project
 * nests inside another. Mirrors the server's association rule
 * (`collectProjects`: `cwd === path || cwd.startsWith(path + "/")`). Returns
 * undefined for a session whose cwd is under no configured project.
 */
export function projectForSession(
  session: SessionInfo,
  projects: ProjectInfo[],
): ProjectInfo | undefined {
  const cwd = session.cwd;
  if (!cwd) return undefined;
  let best: ProjectInfo | undefined;
  for (const p of projects) {
    if (cwd === p.path || cwd.startsWith(p.path + "/")) {
      if (!best || p.path.length > best.path.length) best = p;
    }
  }
  return best;
}

/** Live, interactive (non-headless) sorts ahead of everything; within a tier,
 *  most-recent activity first. The ordering a resumeable list wants: what's
 *  running and what you touched last, at the top. */
function byActivity(a: SessionInfo, b: SessionInfo): number {
  return b.lastActivityAt - a.lastActivityAt;
}

/**
 * Bucket the rendered session list under its projects (AC2.1). Each group holds
 * the project's active (live) sessions and its recent (dead) ones, both ordered
 * newest-first. Only projects that have at least one session appear, and the
 * groups themselves are ordered by their most-recent session activity (a project
 * with a live or freshly-touched session floats up). Sessions under no project
 * are dropped from this view — the project-centric IA has nowhere to put them.
 */
export function groupSessionsByProject(
  sessions: SessionInfo[],
  projects: ProjectInfo[],
): ProjectSessionGroup[] {
  const byPath = new Map<string, ProjectSessionGroup>();
  for (const s of sessions) {
    const p = projectForSession(s, projects);
    if (!p) continue;
    let g = byPath.get(p.path);
    if (!g) {
      g = { project: p, active: [], recent: [] };
      byPath.set(p.path, g);
    }
    (s.live ? g.active : g.recent).push(s);
  }
  const groups = [...byPath.values()];
  for (const g of groups) {
    g.active.sort(byActivity);
    g.recent.sort(byActivity);
  }
  groups.sort((a, b) => {
    const am = Math.max(
      0,
      ...a.active.map((s) => s.lastActivityAt),
      ...a.recent.map((s) => s.lastActivityAt),
    );
    const bm = Math.max(
      0,
      ...b.active.map((s) => s.lastActivityAt),
      ...b.recent.map((s) => s.lastActivityAt),
    );
    return bm - am;
  });
  return groups;
}
