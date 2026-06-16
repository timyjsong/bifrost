import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDir } from "./browse";

describe("listDir", () => {
  let dir: string;

  beforeAll(async () => {
    dir = realpathSync(await mkdtemp(join(tmpdir(), "bifrost-browse-")));
    await mkdir(join(dir, ".git"));
    await mkdir(join(dir, "node_modules"));
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "alpha"));
    await writeFile(join(dir, "README.md"), "hello");
    await writeFile(join(dir, "zeta.txt"), "z");
    await symlink(join(dir, "src"), join(dir, "link-to-src"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("hides .git and node_modules by default", async () => {
    const names = (await listDir(dir, false)).map((e) => e.name);
    expect(names).not.toContain(".git");
    expect(names).not.toContain("node_modules");
  });

  test("reveals .git and node_modules when all=true", async () => {
    const names = (await listDir(dir, true)).map((e) => e.name);
    expect(names).toContain(".git");
    expect(names).toContain("node_modules");
  });

  test("dirs sort before files, each case-insensitive alphabetically", async () => {
    const names = (await listDir(dir, false)).map((e) => e.name);
    // dirs (alpha, src) first, then non-dirs case-insensitively: link-to-src
    // (symlink) < README.md < zeta.txt — friendlier than ASCII's uppercase-first.
    expect(names).toEqual([
      "alpha",
      "src",
      "link-to-src",
      "README.md",
      "zeta.txt",
    ]);
  });

  test("classifies types: dir, file, symlink", async () => {
    const byName = new Map(
      (await listDir(dir, false)).map((e) => [e.name, e.type]),
    );
    expect(byName.get("src")).toBe("dir");
    expect(byName.get("README.md")).toBe("file");
    expect(byName.get("link-to-src")).toBe("symlink");
  });
});
