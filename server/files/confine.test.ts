import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWithinRoot, confinePath } from "./confine";

describe("isWithinRoot (pure)", () => {
  test("same path is within itself", () => {
    expect(isWithinRoot("/a/b", "/a/b")).toBe(true);
  });
  test("nested path is within", () => {
    expect(isWithinRoot("/a/b/c", "/a/b")).toBe(true);
  });
  test("prefix trap: sibling sharing a name prefix is NOT within", () => {
    expect(isWithinRoot("/a/b-secrets", "/a/b")).toBe(false);
  });
  test("outside is not within", () => {
    expect(isWithinRoot("/a/x", "/a/b")).toBe(false);
  });
  test("parent is not within its child", () => {
    expect(isWithinRoot("/a", "/a/b")).toBe(false);
  });
});

// Exercise the real syscall — the security property is realpath's behavior, not
// a mock of it. tmpdir() itself can be a symlink (/tmp -> /private/tmp etc.), so
// canonicalize the base up front and compare against canonical roots.
describe("confinePath (real filesystem)", () => {
  let base: string; // canonical scratch root
  let root: string; // a "project" root we confine to
  let outside: string; // a sibling dir outside the root — stands in for secrets

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "bifrost-confine-"));
    base = realpathSync(base);
    root = join(base, "project");
    outside = join(base, "outside");
    await mkdir(join(root, "sub", "deep"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "oauth-token");
    // a symlink INSIDE the root that points OUT of it — the escape attempt
    await symlink(outside, join(root, "escape"));
    // a symlink inside the root that stays inside — legitimately navigable
    await symlink(join(root, "sub"), join(root, "loop-in"));
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("the root itself is admitted", async () => {
    const r = await confinePath(root, [root]);
    expect(r).toEqual({ ok: true, path: root });
  });

  test("a real subdirectory is admitted", async () => {
    const r = await confinePath(join(root, "sub", "deep"), [root]);
    expect(r).toEqual({ ok: true, path: join(root, "sub", "deep") });
  });

  test("a `..` escape resolves outside and is rejected", async () => {
    const r = await confinePath(join(root, "..", "outside"), [root]);
    expect(r).toEqual({ ok: false, reason: "outside-root" });
  });

  test("a symlink pointing outside the root is rejected", async () => {
    const r = await confinePath(join(root, "escape"), [root]);
    expect(r).toEqual({ ok: false, reason: "outside-root" });
  });

  test("a symlink pointing inside the root is admitted (resolved)", async () => {
    const r = await confinePath(join(root, "loop-in"), [root]);
    expect(r).toEqual({ ok: true, path: join(root, "sub") });
  });

  test("a path outside every root is rejected", async () => {
    const r = await confinePath(outside, [root]);
    expect(r).toEqual({ ok: false, reason: "outside-root" });
  });

  test("a nonexistent path is not-found", async () => {
    const r = await confinePath(join(root, "nope"), [root]);
    expect(r).toEqual({ ok: false, reason: "not-found" });
  });

  test("admitted when inside ANY of several roots", async () => {
    const r = await confinePath(join(root, "sub"), [outside, root]);
    expect(r).toEqual({ ok: true, path: join(root, "sub") });
  });
});
