import { describe, expect, test } from "bun:test";
import { DIFF_BYTE_CAP, parseShortstat, sessionDiff } from "./diff";

describe("parseShortstat", () => {
  test("full shortstat parses", () => {
    expect(parseShortstat(" 3 files changed, 10 insertions(+), 2 deletions(-)")).toEqual({
      files: 3,
      insertions: 10,
      deletions: 2,
    });
  });

  test("singulars and partials parse", () => {
    expect(parseShortstat(" 1 file changed, 1 insertion(+)")).toEqual({
      files: 1,
      insertions: 1,
      deletions: 0,
    });
    expect(parseShortstat("")).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });
});

describe("sessionDiff", () => {
  test("a non-git cwd reads {git:false}", async () => {
    const d = await sessionDiff("/x", async () => ({ code: 128, stdout: "" }));
    expect(d).toEqual({ git: false });
  });

  test("a git cwd returns stat + capped diff", async () => {
    const big = "+".repeat(DIFF_BYTE_CAP + 10);
    const d = await sessionDiff("/x", async (argv) => {
      if (argv.includes("--is-inside-work-tree")) return { code: 0, stdout: "true\n" };
      if (argv.includes("--shortstat"))
        return { code: 0, stdout: " 2 files changed, 5 insertions(+), 1 deletion(-)" };
      return { code: 0, stdout: big };
    });
    expect(d.git).toBe(true);
    if (d.git) {
      expect(d.stat).toEqual({ files: 2, insertions: 5, deletions: 1 });
      expect(d.truncated).toBe(true);
      expect(d.diff.length).toBe(DIFF_BYTE_CAP);
    }
  });
});
