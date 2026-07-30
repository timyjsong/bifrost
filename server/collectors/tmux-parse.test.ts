import { describe, expect, test } from "bun:test";
import { parseTmuxSessions, parseTmuxPanes } from "./system";

// Regression: tmux replaces control characters with `_` in `-F` output (observed
// on tmux 3.6), so a tab-delimited format comes back as ONE field. Nothing
// throws — the parse just yields no rows, `deriveVia` never resolves a session
// into a pane, every session reads as "not tmux-resident", and driving is gated
// off across the whole dashboard. These tests pin the delimiter contract so a
// tab can't quietly come back.
describe("parseTmuxSessions", () => {
  test("parses colon-delimited rows from tmux ls", () => {
    const raw = "work:2:1785370676:1\nscratch:1:1785300000:0\n";
    expect(parseTmuxSessions(raw)).toEqual([
      { name: "work", windows: 2, createdAt: 1785370676000, attached: true },
      { name: "scratch", windows: 1, createdAt: 1785300000000, attached: false },
    ]);
  });

  test("a tab-mangled line yields no row rather than a bogus one", () => {
    // What tmux 3.6 actually returns if the format uses a tab.
    expect(parseTmuxSessions("work_2_1785370676_1\n")).toEqual([]);
  });

  test("ignores blank and truncated lines", () => {
    expect(parseTmuxSessions("\n\nonlyname\n")).toEqual([]);
  });

  test("a missing created stamp degrades to 0, not NaN", () => {
    const [row] = parseTmuxSessions("work:1::0");
    expect(row?.createdAt).toBe(0);
  });
});

describe("parseTmuxPanes", () => {
  test("maps a pane tty to its session", () => {
    const raw = "/dev/pts/6:work:1\n/dev/pts/8:scratch:0\n";
    expect(parseTmuxPanes(raw)).toEqual([
      { tty: "/dev/pts/6", session: "work", attached: true },
      { tty: "/dev/pts/8", session: "scratch", attached: false },
    ]);
  });

  test("a tty path keeps its slashes — only the separator splits", () => {
    const [pane] = parseTmuxPanes("/dev/pts/12:my-project:0");
    expect(pane?.tty).toBe("/dev/pts/12");
    expect(pane?.session).toBe("my-project");
  });

  test("a tab-mangled line yields no pane, so nothing is mis-attributed", () => {
    expect(parseTmuxPanes("/dev/pts/6_work_1\n")).toEqual([]);
  });

  test("attached counts clients: any client above zero is attached", () => {
    expect(parseTmuxPanes("/dev/pts/1:a:3")[0]?.attached).toBe(true);
    expect(parseTmuxPanes("/dev/pts/1:a:0")[0]?.attached).toBe(false);
  });
});
