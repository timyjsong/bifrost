import { describe, expect, test } from "bun:test";
import {
  groupSessionsByProject,
  projectForSession,
} from "./projectSessions";
import type { ProjectInfo, SessionInfo } from "../../../shared/types";

const proj = (over: Partial<ProjectInfo> & { path: string }): ProjectInfo => ({
  name: over.name ?? over.path.slice(over.path.lastIndexOf("/") + 1),
  realm: over.realm ?? "code",
  path: over.path,
  lastActivityAt: over.lastActivityAt ?? 0,
  liveSessions: over.liveSessions ?? 0,
  recentSessions: over.recentSessions ?? 0,
  ...over,
});

const sess = (over: Partial<SessionInfo> & { sessionId: string }): SessionInfo => ({
  live: false,
  cwd: "/home/you/code/bifrost",
  lastActivityAt: 0,
  ...over,
});

const bifrost = proj({ path: "/home/you/code/bifrost" });
const ledger-api = proj({ path: "/home/you/code/ledger-api" });
const projects = [bifrost, ledger-api];

describe("projectForSession (AC2.1) — cwd nests under its project", () => {
  test("cwd equal to project path matches", () => {
    expect(projectForSession(sess({ sessionId: "1", cwd: "/home/you/code/bifrost" }), projects))
      .toBe(bifrost);
  });

  test("cwd under the project path matches (subdir)", () => {
    expect(
      projectForSession(sess({ sessionId: "2", cwd: "/home/you/code/bifrost/web/src" }), projects),
    ).toBe(bifrost);
  });

  test("a sibling prefix does not match (boundary is the slash)", () => {
    // "/home/you/code/bifrost-old" must NOT match "/home/you/code/bifrost".
    expect(
      projectForSession(sess({ sessionId: "3", cwd: "/home/you/code/bifrost-old" }), projects),
    ).toBeUndefined();
  });

  test("most specific (longest) project path wins when projects nest", () => {
    const outer = proj({ path: "/home/you/code" });
    const inner = proj({ path: "/home/you/code/bifrost" });
    expect(
      projectForSession(sess({ sessionId: "4", cwd: "/home/you/code/bifrost/x" }), [outer, inner]),
    ).toBe(inner);
  });

  test("cwd under no project is unmatched", () => {
    expect(
      projectForSession(sess({ sessionId: "5", cwd: "/tmp/scratch" }), projects),
    ).toBeUndefined();
  });

  test("empty cwd is unmatched", () => {
    expect(projectForSession(sess({ sessionId: "6", cwd: "" }), projects)).toBeUndefined();
  });
});

describe("groupSessionsByProject (AC2.1) — active + recent under each project", () => {
  test("splits live → active and dead → recent, only seeded projects appear", () => {
    const groups = groupSessionsByProject(
      [
        sess({ sessionId: "a", cwd: "/home/you/code/bifrost", live: true, lastActivityAt: 100 }),
        sess({ sessionId: "b", cwd: "/home/you/code/bifrost", live: false, lastActivityAt: 50 }),
      ],
      projects,
    );
    expect(groups).toHaveLength(1); // ledger-api has no sessions → absent
    expect(groups[0].project).toBe(bifrost);
    expect(groups[0].active.map((s) => s.sessionId)).toEqual(["a"]);
    expect(groups[0].recent.map((s) => s.sessionId)).toEqual(["b"]);
  });

  test("sessions are newest-first within active and within recent", () => {
    const [g] = groupSessionsByProject(
      [
        sess({ sessionId: "old", cwd: "/home/you/code/bifrost", lastActivityAt: 10 }),
        sess({ sessionId: "new", cwd: "/home/you/code/bifrost", lastActivityAt: 90 }),
        sess({ sessionId: "mid", cwd: "/home/you/code/bifrost", lastActivityAt: 50 }),
      ],
      projects,
    );
    expect(g.recent.map((s) => s.sessionId)).toEqual(["new", "mid", "old"]);
  });

  test("groups order by their most-recent session activity", () => {
    const groups = groupSessionsByProject(
      [
        sess({ sessionId: "m", cwd: "/home/you/code/ledger-api", lastActivityAt: 200 }),
        sess({ sessionId: "b", cwd: "/home/you/code/bifrost", lastActivityAt: 100 }),
      ],
      projects,
    );
    expect(groups.map((g) => g.project.path)).toEqual([
      "/home/you/code/ledger-api",
      "/home/you/code/bifrost",
    ]);
  });

  test("sessions under no project are dropped from the project-centric view", () => {
    const groups = groupSessionsByProject(
      [sess({ sessionId: "x", cwd: "/tmp/elsewhere", live: true, lastActivityAt: 999 })],
      projects,
    );
    expect(groups).toHaveLength(0);
  });
});
