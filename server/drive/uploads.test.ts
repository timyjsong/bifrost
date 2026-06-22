import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../alerts/store";
import { safeSid, safeUploadName, isExpired, saveUpload, sweepUploads } from "./uploads";

describe("safeSid — traversal-safe dir key", () => {
  test("keeps UUID chars, strips path/odd chars, falls back", () => {
    expect(safeSid("8a67e9da-21a4-49da")).toBe("8a67e9da-21a4-49da");
    expect(safeSid("../../etc/passwd")).toBe("etcpasswd");
    expect(safeSid("")).toBe("unknown");
  });
});

describe("safeUploadName — safe, collision-resistant filename", () => {
  test("strips any path + unsafe chars, prefixes the token", () => {
    expect(safeUploadName("../../evil name!.png", "ab12")).toBe("ab12-evil_name_.png");
  });
  test("empty / path-only names fall back to 'file'", () => {
    expect(safeUploadName("", "tok")).toBe("tok-file");
    expect(safeUploadName("///", "tok")).toBe("tok-file");
  });
});

describe("isExpired — TTL boundary", () => {
  test("older than ttl expires; within ttl does not", () => {
    expect(isExpired(0, 1000, 500)).toBe(true);
    expect(isExpired(1000, 1200, 500)).toBe(false);
  });
});

describe("saveUpload + sweepUploads", () => {
  test("saves under data/uploads/<sid>, returns its path, and the TTL sweep removes it", async () => {
    const sid = "test-sess-1";
    const { path, name } = await saveUpload(sid, "hello.txt", new Uint8Array([104, 105]));
    expect(path).toContain(join(dataDir, "uploads", sid));
    expect(name).toMatch(/-hello\.txt$/);
    expect((await readdir(join(dataDir, "uploads", sid))).length).toBe(1);

    // sweep with a far-future "now" → everything is older than the TTL → cleaned
    await sweepUploads(Number.MAX_SAFE_INTEGER, 1);
    let after: string[] = [];
    try {
      after = await readdir(join(dataDir, "uploads", sid));
    } catch {
      after = [];
    }
    expect(after.length).toBe(0);
  });
});
