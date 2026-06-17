import { describe, expect, test } from "bun:test";
import { resolveTarget, liveTmuxSet } from "./target";

const live = new Set(["work", "atlas-web", "bifrost"]);

describe("resolveTarget — the drive-target security boundary", () => {
  test("a live tmux-resident session resolves to its target", () => {
    expect(resolveTarget({ tmuxSession: "atlas-web" }, live)).toEqual({
      ok: true,
      tmuxSession: "atlas-web",
    });
  });

  test("a session with no tmuxSession is not injectable", () => {
    expect(resolveTarget({}, live)).toEqual({ ok: false, reason: "not-injectable" });
    expect(resolveTarget(undefined, live)).toEqual({
      ok: false,
      reason: "not-injectable",
    });
    expect(resolveTarget({ tmuxSession: "" }, live)).toEqual({
      ok: false,
      reason: "not-injectable",
    });
  });

  test("a tmux session no longer live is rejected (died between render and send)", () => {
    expect(resolveTarget({ tmuxSession: "dead-session" }, live)).toEqual({
      ok: false,
      reason: "session-gone",
    });
  });

  test("a forged/injection-shaped name is rejected, not sanitized", () => {
    // exact membership is the whole check: these simply aren't live names
    for (const forged of ["atlas-web; rm -rf ~", "$(whoami)", "atlas-web\nwork", "../work"]) {
      expect(resolveTarget({ tmuxSession: forged }, live).ok).toBe(false);
    }
  });

  test("exact-match only — no prefix/substring leak", () => {
    expect(resolveTarget({ tmuxSession: "wor" }, live).ok).toBe(false);
    expect(resolveTarget({ tmuxSession: "work2" }, live).ok).toBe(false);
  });
});

describe("liveTmuxSet", () => {
  test("collapses a tmux snapshot to a name set", () => {
    const set = liveTmuxSet([{ name: "a" }, { name: "b" }]);
    expect(set.has("a")).toBe(true);
    expect(set.has("c")).toBe(false);
  });
});
