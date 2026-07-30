import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDirsRequest } from "./handler";
import type { DirPick } from "../../shared/types";

// The originate picker's directory browser: home-rooted confinement,
// subdirectories only, dot-folders hidden.
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bifrost-dirs-"));
  await mkdir(join(root, "projects", "alpha"), { recursive: true });
  await mkdir(join(root, "projects", "beta"), { recursive: true });
  await mkdir(join(root, ".hidden"), { recursive: true });
  await writeFile(join(root, "notes.txt"), "not a dir");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const req = (path?: string) =>
  handleDirsRequest(
    new URL(`http://x/api/dirs${path ? `?${new URLSearchParams({ path })}` : ""}`),
    root,
  );

describe("handleDirsRequest — /api/dirs", () => {
  test("no path starts at the root; parent is null there", async () => {
    const res = (await req())!;
    const body = (await res.json()) as DirPick;
    expect(body.parent).toBeNull();
    expect(body.dirs).toContain("projects");
  });

  test("dirs only — files and dot-folders are hidden", async () => {
    const res = (await req())!;
    const body = (await res.json()) as DirPick;
    expect(body.dirs).not.toContain("notes.txt");
    expect(body.dirs).not.toContain(".hidden");
  });

  test("descending lists the child and reports its parent", async () => {
    const res = (await req(join(root, "projects")))!;
    const body = (await res.json()) as DirPick;
    expect(body.dirs).toEqual(["alpha", "beta"]);
    expect(body.parent).toBe(root);
  });

  test("escaping the root is rejected", async () => {
    const res = (await req(join(root, "..")))!;
    expect(res.status).toBe(403);
  });

  test("a nonexistent path is a 404", async () => {
    const res = (await req(join(root, "nope")))!;
    expect(res.status).toBe(404);
  });

  test("other routes are ignored", async () => {
    expect(await handleDirsRequest(new URL("http://x/api/files?path=/"), root)).toBeNull();
  });
});
