/**
 * `collectors/projects.ts` had no test file at all, and the README's coverage
 * paragraph names it — so this is a gap we committed to in writing.
 *
 * The tests run against real directories and real `git` rather than mocking the
 * spawn: what this collector does IS read a working tree, and a fake git would
 * only assert that the fake was called.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectProjects } from "./projects";
import { tempDir, sweepTempDirs } from "../testing/tmp";
import type { BifrostConfig } from "../config";
import type { SessionInfo } from "../../shared/types";

afterAll(sweepTempDirs);

const realm = (path: string, name = "work") =>
  ({ realms: [{ name, path }] }) as BifrostConfig;

const session = (cwd: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({
    sessionId: `s-${cwd}`,
    cwd,
    live: false,
    lastActivityAt: 0,
    ...over,
  }) as SessionInfo;

function project(root: string, name: string, files: Record<string, string> = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  return dir;
}

async function git(dir: string, ...args: string[]) {
  const p = Bun.spawn(["git", "-C", dir, ...args], {
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
           GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
  await p.exited;
}

describe("directory scanning", () => {
  test("lists each directory in the realm, ignoring files and dotdirs", async () => {
    const root = tempDir("bifrost-proj");
    project(root, "alpha");
    project(root, "beta");
    project(root, ".hidden");
    writeFileSync(join(root, "loose.txt"), "not a project");

    const out = await collectProjects(realm(root), []);
    expect(out.map((p) => p.name).sort()).toEqual(["alpha", "beta"]);
    expect(out.every((p) => p.realm === "work")).toBe(true);
  });

  test("a realm that does not exist is skipped, not fatal", async () => {
    const root = tempDir("bifrost-proj");
    project(root, "alpha");
    const cfg = {
      realms: [{ name: "gone", path: "/nonexistent/realm" }, { name: "work", path: root }],
    } as BifrostConfig;
    const out = await collectProjects(cfg, []);
    expect(out.map((p) => p.name)).toEqual(["alpha"]);
  });

  test("a directory that is not a repo simply has no git info", async () => {
    const root = tempDir("bifrost-proj");
    project(root, "plain");
    const [p] = await collectProjects(realm(root), []);
    expect(p.git).toBeUndefined();
  });
});

describe("session attribution", () => {
  // The prefix trap: `/root/api-secrets` must NOT count as inside `/root/api`.
  // Same class of bug as files/confine.ts, and here it would mean one project's
  // card silently reporting another project's live sessions.
  test("a sibling whose name merely starts with the project name is not inside it", async () => {
    const root = tempDir("bifrost-proj");
    const api = project(root, "api");
    project(root, "api-secrets");

    const out = await collectProjects(realm(root), [
      session(api),
      session(join(root, "api-secrets")),
      session(join(root, "api-secrets", "deep")),
    ]);
    const byName = Object.fromEntries(out.map((p) => [p.name, p]));
    expect(byName.api.recentSessions).toBe(1);
    expect(byName["api-secrets"].recentSessions).toBe(2);
  });

  test("the project's own directory and anything under it count", async () => {
    const root = tempDir("bifrost-proj");
    const api = project(root, "api");
    const out = await collectProjects(realm(root), [
      session(api),
      session(join(api, "src")),
      session(join(api, "src", "deep", "nested")),
    ]);
    expect(out[0].recentSessions).toBe(3);
  });

  test("live sessions are counted separately from recent ones", async () => {
    const root = tempDir("bifrost-proj");
    const api = project(root, "api");
    const out = await collectProjects(realm(root), [
      session(api, { live: true }),
      session(join(api, "a"), { live: true }),
      session(join(api, "b"), { live: false }),
    ]);
    expect(out[0].liveSessions).toBe(2);
    expect(out[0].recentSessions).toBe(3);
  });

  test("a session with no cwd is attributed to nothing", async () => {
    const root = tempDir("bifrost-proj");
    project(root, "api");
    const out = await collectProjects(realm(root), [session("", { cwd: undefined })]);
    expect(out[0].recentSessions).toBe(0);
  });
});

describe("blurb extraction from the README", () => {
  const blurbOf = async (readme: string) => {
    const root = tempDir("bifrost-proj");
    project(root, "p", { "README.md": readme });
    const [p] = await collectProjects(realm(root), []);
    return p.blurb;
  };

  test("takes the first real prose line, skipping the title", async () => {
    expect(await blurbOf("# Title\n\nWhat it does.\n")).toBe("What it does.");
  });

  test("skips badges, blockquotes and rules", async () => {
    expect(await blurbOf("# T\n![badge](x.svg)\n> a quote\n---\nThe real line.\n")).toBe(
      "The real line.",
    );
  });

  test("strips link syntax and emphasis, keeping the words", async () => {
    expect(await blurbOf("A [linked](http://x) and *bold* `code` thing.")).toBe(
      "A linked and bold code thing.",
    );
  });

  // The requirement is that a blurb stays short enough for a card and says it
  // was cut — not an exact width. (It currently lands on 178: the 180 budget
  // spends 177 characters plus the ellipsis.)
  test("truncates a very long line with an ellipsis, within the budget", async () => {
    const b = (await blurbOf("x".repeat(500)))!;
    expect(b.length).toBeLessThanOrEqual(180);
    expect(b.endsWith("…")).toBe(true);
  });

  test("a line just under the budget is left exactly as it is", async () => {
    const line = "y".repeat(180);
    expect(await blurbOf(line)).toBe(line);
  });

  test("a README with nothing but a title yields no blurb", async () => {
    expect(await blurbOf("# Just a title\n\n## And a heading\n")).toBeUndefined();
  });

  test("no README at all yields no blurb", async () => {
    const root = tempDir("bifrost-proj");
    project(root, "p");
    const [p] = await collectProjects(realm(root), []);
    expect(p.blurb).toBeUndefined();
  });
});

describe("git info", () => {
  test("reads branch, last commit and dirty count from a real repo", async () => {
    const root = tempDir("bifrost-proj");
    const dir = project(root, "repo", { "a.txt": "one" });
    await git(dir, "init", "-q", "-b", "trunk");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "first commit");
    writeFileSync(join(dir, "b.txt"), "untracked");
    writeFileSync(join(dir, "a.txt"), "changed");

    const [p] = await collectProjects(realm(root), []);
    expect(p.git?.branch).toBe("trunk");
    expect(p.git?.lastCommitMsg).toBe("first commit");
    expect(p.git?.lastCommitAt).toBeGreaterThan(0);
    expect(p.git?.dirty).toBe(2); // one modified, one untracked
  });

  test("a clean repo reports zero dirty files", async () => {
    const root = tempDir("bifrost-proj");
    const dir = project(root, "repo", { "a.txt": "one" });
    await git(dir, "init", "-q", "-b", "main");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "only");
    const [p] = await collectProjects(realm(root), []);
    expect(p.git?.dirty).toBe(0);
  });

  // A repo with no commits: `git log` fails, but the branch is still readable
  // from HEAD, so the project must still render rather than losing its git info.
  test("a repo with no commits still reports its branch", async () => {
    const root = tempDir("bifrost-proj");
    const dir = project(root, "empty");
    await git(dir, "init", "-q", "-b", "main");
    const [p] = await collectProjects(realm(root), []);
    expect(p.git?.branch).toBe("main");
    expect(p.git?.lastCommitAt).toBe(0);
  });
});

describe("activity and ordering", () => {
  test("lastActivityAt takes the newest of commit time, dir mtime and sessions", async () => {
    const root = tempDir("bifrost-proj");
    const dir = project(root, "p");
    const future = Date.now() + 60_000;
    const [p] = await collectProjects(realm(root), [
      session(dir, { lastActivityAt: future }),
    ]);
    expect(p.lastActivityAt).toBe(future);
  });

  test("projects come back newest-first", async () => {
    const root = tempDir("bifrost-proj");
    const a = project(root, "stale");
    const b = project(root, "fresh");
    const out = await collectProjects(realm(root), [
      session(a, { lastActivityAt: 1_000 }),
      session(b, { lastActivityAt: 9_000_000_000_000 }),
    ]);
    expect(out.map((p) => p.name)).toEqual(["fresh", "stale"]);
  });

  test("realms are all scanned, and the result is sorted across them", async () => {
    const r1 = tempDir("bifrost-r1");
    const r2 = tempDir("bifrost-r2");
    const a = project(r1, "one");
    const b = project(r2, "two");
    const cfg = {
      realms: [{ name: "r1", path: r1 }, { name: "r2", path: r2 }],
    } as BifrostConfig;
    const out = await collectProjects(cfg, [
      session(a, { lastActivityAt: 1_000 }),
      session(b, { lastActivityAt: 9_000_000_000_000 }),
    ]);
    expect(out.map((p) => `${p.realm}/${p.name}`)).toEqual(["r2/two", "r1/one"]);
  });
});
