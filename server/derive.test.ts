import { describe, expect, test } from "bun:test";
import {
  descendantsOf,
  leafChildren,
  cleanCommand,
  deriveState,
  settleStates,
  attributeBackground,
  deriveVia,
  nameFromCallIndex,
  canonCommand,
  cpuPctInstant,
  isPrintCmdline,
  launchModelFromCmdline,
  resolveContextMeter,
  windowForModel,
  windowFromModelLog,
} from "./derive";
import type { SessionInfo, ProcInfo } from "../shared/types";
import type { SessionSignals } from "./collectors/sessions";

// tree: 1 -> 2 -> 3, 1 -> 4; 5 standalone
const TREE: [number, number][] = [
  [2, 1],
  [3, 2],
  [4, 1],
  [5, 100],
];

const proc = (pid: number, over: Partial<ProcInfo> = {}): ProcInfo => ({
  pid,
  ppid: 0,
  user: "dev",
  rssKb: 1000,
  cpu: 0,
  etime: "01:00",
  command: `cmd-${pid}`,
  isClaude: false,
  ...over,
});

describe("descendantsOf", () => {
  test("collects transitive descendants", () => {
    expect([...descendantsOf(1, TREE)].sort()).toEqual([2, 3, 4]);
  });
  test("leaf root has none", () => {
    expect(descendantsOf(3, TREE).size).toBe(0);
  });
});

describe("leafChildren", () => {
  test("returns only leaves, not intermediate wrappers", () => {
    const leaves = leafChildren(descendantsOf(1, TREE), TREE, [
      proc(2),
      proc(3),
      proc(4),
    ]);
    expect(leaves.map((l) => l.pid).sort()).toEqual([3, 4]); // 2 is a parent
  });
  test("caps at 6, sorted by cpu then rss", () => {
    const tree: [number, number][] = Array.from({ length: 9 }, (_, i) => [
      10 + i,
      1,
    ]);
    const procs = Array.from({ length: 9 }, (_, i) =>
      proc(10 + i, { cpu: i, rssKb: 100 * i }),
    );
    const leaves = leafChildren(descendantsOf(1, tree), tree, procs);
    expect(leaves.length).toBe(6);
    expect(leaves[0].pid).toBe(18); // highest cpu first
  });
});

describe("cleanCommand", () => {
  test("strips shell-snapshot wrapper to the eval'd command", () => {
    const wrapped =
      "/bin/bash -c source /home/you/.claude/shell-snapshots/snap.sh 2>/dev/null || true && eval 'sleep 600' < /dev/null";
    expect(cleanCommand(wrapped)).toBe("sleep 600");
  });
  test("truncates long commands", () => {
    expect(cleanCommand("x".repeat(200)).length).toBe(88); // 87 chars + ellipsis
  });
});

describe("cpuPctInstant", () => {
  test("full-core burn over a 3s tick reads 100 on one core", () => {
    expect(cpuPctInstant(300, 3000)).toBe(100);
  });
  test("normalizes to box share across cores", () => {
    expect(cpuPctInstant(300, 3000, 3)).toBe(33.3); // one core of three
    expect(cpuPctInstant(900, 3000, 3)).toBe(100); // all three saturated
  });
  test("light use reads proportionally", () => {
    expect(cpuPctInstant(30, 3000)).toBe(10);
  });
  test("idle, negative (pid reuse), and zero-interval read 0", () => {
    expect(cpuPctInstant(0, 3000)).toBe(0);
    expect(cpuPctInstant(-50, 3000)).toBe(0);
    expect(cpuPctInstant(10, 0)).toBe(0);
  });
  test("clamps at 100 — nothing exceeds the box", () => {
    expect(cpuPctInstant(10_000, 1000, 3)).toBe(100);
  });
});

describe("isPrintCmdline", () => {
  test("claude -p with a prompt is print mode", () => {
    expect(
      isPrintCmdline("claude -p Read the contract and transcribe --model opus"),
    ).toBe(true);
    expect(isPrintCmdline("claude --print something")).toBe(true);
  });
  test("interactive cmdlines are not", () => {
    expect(isPrintCmdline("claude --model fable[1m]")).toBe(false);
    expect(
      isPrintCmdline(
        "/home/you/.claude/remote/ccd-cli/2.1.170 --output-format stream-json --verbose --input-format stream-json --resume abc",
      ),
    ).toBe(false);
    expect(isPrintCmdline(undefined)).toBe(false);
  });
});

describe("launchModelFromCmdline", () => {
  test("extracts the --model flag with its [1m] variant", () => {
    expect(launchModelFromCmdline("claude --model fable[1m]")).toBe("fable[1m]");
    expect(
      launchModelFromCmdline(
        "/home/you/.claude/remote/ccd-cli/2.1.170 --output-format stream-json --model claude-opus-4-8[1m] --resume abc",
      ),
    ).toBe("claude-opus-4-8[1m]");
    expect(launchModelFromCmdline("claude --model=opus")).toBe("opus");
  });
  test("bare launches yield nothing", () => {
    expect(launchModelFromCmdline("claude")).toBeUndefined();
    expect(launchModelFromCmdline(undefined)).toBeUndefined();
  });
});

describe("windowForModel", () => {
  test("[1m] suffix and (1M context) marker mean 1M", () => {
    expect(windowForModel("claude-opus-4-8[1m]")).toBe(1_000_000);
    expect(windowForModel("Opus 4.8 (1M context)")).toBe(1_000_000);
  });
  test("Fable is 1M unconditionally (verified via /context)", () => {
    expect(windowForModel("Fable 5")).toBe(1_000_000);
    expect(windowForModel("claude-fable-5")).toBe(1_000_000);
  });
  test("Opus base / Sonnet / Haiku are 200K", () => {
    expect(windowForModel("claude-opus-4-8")).toBe(200_000);
    expect(windowForModel("Sonnet 4.6")).toBe(200_000);
    expect(windowForModel("Haiku 4.5")).toBe(200_000);
  });
});

describe("windowFromModelLog", () => {
  test("ANSI-styled display format: bold code is literally \\x1b[1m", () => {
    // observed live 2026-06-11: styling stripped before name mapping
    expect(
      windowFromModelLog(
        "Set model to \x1b[1mOpus 4.8 (1M context)\x1b[22m and saved as your default",
      ),
    ).toBe(1_000_000);
    // Fable's stdout omits any context marker, yet it is 1M
    expect(
      windowFromModelLog(
        "Set model to \x1b[1mFable 5\x1b[22m and saved as your default",
      ),
    ).toBe(1_000_000);
    expect(
      windowFromModelLog(
        "Set model to \x1b[1mHaiku 4.5\x1b[22m and saved as your default",
      ),
    ).toBe(200_000);
  });
  test("non-matching text yields nothing", () => {
    expect(windowFromModelLog("some other stdout")).toBeUndefined();
  });
});

describe("resolveContextMeter", () => {
  test("tier 1: /model switch log wins; usage entries name the model", () => {
    expect(
      resolveContextMeter({
        setWindow: 1_000_000,
        launchModel: "fable[1m]",
        msgModel: "claude-opus-4-8",
      }),
    ).toEqual({
      window: 1_000_000,
      windowSrc: "model-log",
      model: "claude-opus-4-8[1m]",
    });
    // variant-only downswitch: opus[1m] -> opus
    expect(
      resolveContextMeter({ setWindow: 200_000, msgModel: "claude-opus-4-8" }),
    ).toMatchObject({ window: 200_000, model: "claude-opus-4-8" });
  });
  test("tier 2: launch flag decides the window; transcript names the model", () => {
    const m = resolveContextMeter({
      launchModel: "fable[1m]",
      msgModel: "claude-fable-5",
    });
    expect(m.window).toBe(1_000_000);
    expect(m.windowSrc).toBe("launch-flag");
    expect(m.model).toBe("claude-fable-5[1m]");
    expect(
      resolveContextMeter({ launchModel: "opus", msgModel: "claude-opus-4-8" })
        .window,
    ).toBe(200_000);
  });
  test("tier 3: lastModelUsage only when unambiguous", () => {
    const base = { msgModel: "claude-opus-4-8" };
    expect(
      resolveContextMeter({
        ...base,
        projectModels: ["claude-opus-4-8[1m]"],
      }),
    ).toMatchObject({ window: 1_000_000, windowSrc: "last-model-usage" });
    expect(
      resolveContextMeter({
        ...base,
        projectModels: ["claude-opus-4-8"],
      }),
    ).toMatchObject({ window: 200_000, windowSrc: "last-model-usage" });
    // both variants used in the project: ambiguous, fall to labeled lookup
    expect(
      resolveContextMeter({
        ...base,
        projectModels: ["claude-opus-4-8", "claude-opus-4-8[1m]"],
      }),
    ).toMatchObject({ window: 200_000, windowSrc: "lookup" });
  });
  test("tier 4: nothing known = 200K labeled lookup", () => {
    expect(resolveContextMeter({})).toMatchObject({
      window: 200_000,
      windowSrc: "lookup",
    });
  });
  test("saved-default: a bare launch inherits the /model saved default", () => {
    // bare launch (no /model this session, no --model), saved default is 1M
    expect(
      resolveContextMeter({ msgModel: "claude-opus-4-8", savedDefault: 1_000_000 }),
    ).toEqual({
      window: 1_000_000,
      windowSrc: "saved-default",
      model: "claude-opus-4-8[1m]",
    });
    // a 200K saved default reads 200K — and counts as measured, not a guess
    expect(
      resolveContextMeter({ msgModel: "claude-sonnet-4-6", savedDefault: 200_000 }),
    ).toMatchObject({ window: 200_000, windowSrc: "saved-default" });
    // this session's own /model log still wins over the inherited default
    expect(
      resolveContextMeter({
        setWindow: 200_000,
        savedDefault: 1_000_000,
        msgModel: "claude-opus-4-8",
      }),
    ).toMatchObject({ window: 200_000, windowSrc: "model-log" });
  });
  test("token-floor: measured tokens over the resolved window promote it to 1M", () => {
    // the ambiguous case above, but the session holds 255K tokens — impossible
    // in a 200K window, so the real window is 1M and the model is the [1m] variant.
    expect(
      resolveContextMeter({
        msgModel: "claude-opus-4-8",
        projectModels: ["claude-opus-4-8", "claude-opus-4-8[1m]"],
        tokens: 254_990,
      }),
    ).toEqual({
      window: 1_000_000,
      windowSrc: "token-floor",
      model: "claude-opus-4-8[1m]",
    });
    // tokens within the resolved window leave it untouched
    expect(
      resolveContextMeter({ msgModel: "claude-opus-4-8", tokens: 50_000 }),
    ).toMatchObject({ window: 200_000, windowSrc: "lookup" });
  });
});

describe("nameFromCallIndex", () => {
  const index = (...pairs: [string, string][]) =>
    new Map(pairs.map(([cmd, desc]) => [canonCommand(cmd), desc]));
  const WRAPPER =
    "/bin/bash -c source /home/you/.claude/shell-snapshots/snapshot-bash-1749680518252-deadbeef.sh 2>/dev/null || true && eval 'python3 run_eval.py --epochs 12' < /dev/null";

  test("full wrapper cmdline matches even with the long snapshot preamble", () => {
    const idx = index([
      "python3 run_eval.py --epochs 12",
      "Run the evaluation sweep",
    ]);
    expect(nameFromCallIndex([WRAPPER], idx)).toBe("Run the evaluation sweep");
  });
  test("script indirection: leaf args share no text, wrapper ancestor matches", () => {
    const idx = index(["./scripts/bench.sh --all", "Benchmark everything"]);
    const wrapper = WRAPPER.replace(
      "python3 run_eval.py --epochs 12",
      "./scripts/bench.sh --all",
    );
    // leaf first (no match), then its wrapper (match)
    expect(
      nameFromCallIndex(["python3 /tmp/inner_workload.py", wrapper], idx),
    ).toBe("Benchmark everything");
  });
  test("leaf as subcommand of a compound call matches", () => {
    const idx = index([
      "cd /home/you/atrium/web && bun run build 2>&1 | tail -5",
      "Build the frontend bundle",
    ]);
    expect(
      nameFromCallIndex(["bun run build 2>&1 | tail -5"], idx),
    ).toBe("Build the frontend bundle");
  });
  test("newest call wins on ties", () => {
    const idx = index(
      ["bun run check 2>&1", "Old gate run"],
      ["bun run check 2>&1 | tail -8", "New gate run"],
    );
    expect(nameFromCallIndex(["bun run check 2>&1 | tail -8"], idx)).toBe(
      "New gate run",
    );
  });
  test("short generic texts never match", () => {
    const idx = index(["sleep 600 && echo done", "Long nap"]);
    expect(nameFromCallIndex(["bash"], idx)).toBeUndefined();
  });
  test("unrelated text falls through; empty index is safe", () => {
    const idx = index(["sleep 600 && echo done", "Long nap"]);
    expect(nameFromCallIndex(["python3 train.py --epochs 9000"], idx)).toBeUndefined();
    expect(nameFromCallIndex(["whatever text here"], undefined)).toBeUndefined();
  });
  test("control-char mangling does not break the match", () => {
    const idx = index(["for f in *;\ndo stat $f;\ndone", "Stat everything"]);
    expect(nameFromCallIndex(["for f in *;?do stat $f;?done"], idx)).toBe(
      "Stat everything",
    );
  });
});

describe("deriveVia", () => {
  // mirrors the live box: claude in a pane, claude under sshd, desktop-remote
  const procs = [
    // tmuxed: claude(100) ← bash(90) ← tmux server(80, reparented to init)
    proc(100, { ppid: 90, tty: "pts/2", command: "claude" }),
    proc(90, { ppid: 80, tty: "pts/2", command: "-bash" }),
    proc(80, { ppid: 1, command: "tmux new -s work" }),
    // direct ssh: claude(200) ← bash(190) ← sshd(180)
    proc(200, { ppid: 190, tty: "pts/5", command: "claude" }),
    proc(190, { ppid: 180, tty: "pts/5", command: "-bash" }),
    proc(180, { ppid: 1, command: "sshd: user@pts/5" }),
    // desktop-remote: claude(300) ← remote server(290, reparented to init)
    proc(300, { ppid: 290, command: "/home/you/.claude/remote/ccd-cli/2.1.170" }),
    proc(290, { ppid: 1, command: "/home/you/.claude/remote/srv/abc/server" }),
  ];
  const panes = [{ tty: "/dev/pts/2", session: "ledger-work", attached: false }];

  test("pane tty match wins: tmux session + attach state", () => {
    expect(deriveVia(100, procs, panes)).toEqual({
      tmuxSession: "ledger-work",
      tmuxAttached: false,
    });
  });
  test("attached pane reports attached", () => {
    const attached = [{ ...panes[0], attached: true }];
    expect(deriveVia(100, procs, attached).tmuxAttached).toBe(true);
  });
  test("sshd ancestor = over ssh", () => {
    expect(deriveVia(200, procs, panes)).toEqual({ overSsh: true });
  });
  test("tmuxed session without pane data does NOT read as ssh", () => {
    // tmux server's chain ends at init — no sshd false positive
    expect(deriveVia(100, procs, [])).toEqual({});
  });
  test("desktop-remote matches neither", () => {
    expect(deriveVia(300, procs, panes)).toEqual({});
  });
  test("unknown pid is empty", () => {
    expect(deriveVia(999, procs, panes)).toEqual({});
  });
});

const liveSession = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: "s1",
  live: true,
  cwd: "/home/you/x",
  lastActivityAt: 0,
  ...over,
});

const sig = (over: Partial<SessionSignals> = {}): SessionSignals => ({
  openTools: 0,
  ...over,
});

describe("deriveState", () => {
  test("turn over + no children = awaiting", () => {
    expect(
      deriveState(liveSession(), sig({ lastEntry: "assistant_done" }), 0),
    ).toBe("awaiting");
  });
  test("turn over + children out = paused", () => {
    expect(
      deriveState(liveSession(), sig({ lastEntry: "assistant_done" }), 3),
    ).toBe("paused");
  });
  test("fresh busy pid-status demotes awaiting to working", () => {
    expect(
      deriveState(
        liveSession(),
        sig({
          lastEntry: "assistant_done",
          pidStatus: "busy",
          pidStatusAgeMs: 1000,
        }),
        0,
      ),
    ).toBe("working");
  });
  test("stale busy status does NOT demote", () => {
    expect(
      deriveState(
        liveSession(),
        sig({
          lastEntry: "assistant_done",
          pidStatus: "busy",
          pidStatusAgeMs: 60_000,
        }),
        0,
      ),
    ).toBe("awaiting");
  });
  test("dangling tool + quiet cpu + no children = approval", () => {
    expect(
      deriveState(
        liveSession(),
        sig({ lastEntry: "assistant_tool", openTools: 1, cpuQuietMs: 20_000 }),
        0,
      ),
    ).toBe("approval");
  });
  test("dangling tool with children = working", () => {
    expect(
      deriveState(
        liveSession(),
        sig({ lastEntry: "assistant_tool", openTools: 1, cpuQuietMs: 20_000 }),
        2,
      ),
    ).toBe("working");
  });
  test("user prompt last = working (model generating)", () => {
    expect(
      deriveState(liveSession(), sig({ lastEntry: "user_prompt" }), 0),
    ).toBe("working");
  });
  test("headless and bg sessions get no state", () => {
    expect(
      deriveState(
        liveSession({ headless: true }),
        sig({ lastEntry: "assistant_done" }),
        0,
      ),
    ).toBeUndefined();
    expect(
      deriveState(
        liveSession(),
        sig({ lastEntry: "assistant_done", kind: "bg" }),
        0,
      ),
    ).toBeUndefined();
  });
});

describe("settleStates (post-absorption state)", () => {
  const sigs = (id: string, over = {}) =>
    new Map([[id, sig({ lastEntry: "assistant_done", ...over })]]);

  test("turn over + a re-attributed agent (childProcs>0) is paused, NOT awaiting", () => {
    // The bug: derive state off the post-absorption count, or a session blocked
    // on a fan-out agent falsely reads needs-you.
    const s = liveSession({ sessionId: "a", pid: 100, childProcs: 1 });
    settleStates([s], sigs("a"));
    expect(s.state).toBe("paused");
  });

  test("turn over + genuinely nothing running is awaiting", () => {
    const s = liveSession({ sessionId: "a", pid: 100, childProcs: 0 });
    settleStates([s], sigs("a"));
    expect(s.state).toBe("awaiting");
  });

  test("headless sessions get no state; a pidless session is skipped", () => {
    const h = liveSession({ sessionId: "h", pid: 100, headless: true, childProcs: 0 });
    const nopid = liveSession({ sessionId: "n", state: "working" });
    settleStates([h, nopid], new Map([
      ["h", sig({ lastEntry: "assistant_done" })],
      ["n", sig({ lastEntry: "assistant_done" })],
    ]));
    expect(h.state).toBeUndefined();
    expect(nopid.state).toBe("working"); // untouched — no pid, no signal match path
  });

  test("clears nowDoing once a session is no longer working", () => {
    const s = liveSession({ sessionId: "a", pid: 100, childProcs: 0, nowDoing: "stale" });
    settleStates([s], sigs("a"));
    expect(s.state).toBe("awaiting");
    expect(s.nowDoing).toBeUndefined();
  });
});

describe("attributeBackground (capture every subprocess shape)", () => {
  // owner A is a live interactive session (pid 100); helpers below build the
  // ps-tree descendant map and the fd-link owner map the caller pre-resolves.
  const A = { sessionId: "A", pid: 100, live: true, headless: false };
  const tree = (entries: Record<number, number[]>) =>
    new Map(Object.entries(entries).map(([pid, kids]) => [Number(pid), new Set(kids)]));

  test("foreground tool child (ps-tree) is kept, nothing absorbed", () => {
    const { descByPid, absorbed } = attributeBackground([A], tree({ 100: [200] }), new Map());
    expect([...descByPid.get(100)!]).toEqual([200]);
    expect(absorbed.size).toBe(0);
  });

  test("ORPHANED background shell (not in tree) is recovered via the fd-link", () => {
    // 300 reparented to init — absent from A's ps-tree — but its stdout fd still
    // carries A's task-dir UUID (here == sessionId, the --resume case).
    const { descByPid } = attributeBackground([A], tree({ 100: [] }), new Map([[300, "A"]]));
    expect(descByPid.get(100)!.has(300)).toBe(true);
  });

  test("orphan recovered when the task-dir UUID DIFFERS from the sessionId (post-/clear)", () => {
    // A's own ps-tree child 200 writes to task dir "RT" — so we learn RT->A even
    // though A's sessionId is "A". An orphan 300 also on "RT" is then attributed.
    const { descByPid } = attributeBackground(
      [A], tree({ 100: [200], 200: [] }), new Map([[200, "RT"], [300, "RT"]]),
    );
    expect(descByPid.get(100)!.has(300)).toBe(true); // the orphan, by learned UUID
    expect(descByPid.get(100)!.has(200)).toBe(true); // the tree child, still there
  });

  test("a proc both in the tree AND fd-linked is counted once (set dedup)", () => {
    const { descByPid } = attributeBackground([A], tree({ 100: [300] }), new Map([[300, "A"]]));
    expect([...descByPid.get(100)!]).toEqual([300]);
  });

  test("spawned agent that IS a ps-tree descendant is absorbed (no double-list)", () => {
    // the eval `claude -p` case: a headless session living inside A's tree —
    // shown on A's card, so hidden from the headless group.
    const agent = { sessionId: "B", pid: 500, live: true, headless: true };
    const { descByPid, absorbed } = attributeBackground([A, agent], tree({ 100: [500], 500: [] }), new Map());
    expect(descByPid.get(100)!.has(500)).toBe(true);
    expect([...absorbed]).toEqual(["B"]);
  });

  test("spawned agent attributed ONLY by fd-link (orphaned) is also absorbed", () => {
    const agent = { sessionId: "B", pid: 500, live: true, headless: true };
    const { descByPid, absorbed } = attributeBackground(
      [A, agent], tree({ 100: [], 500: [] }), new Map([[500, "A"]]),
    );
    expect(descByPid.get(100)!.has(500)).toBe(true);
    expect([...absorbed]).toEqual(["B"]);
  });

  test("a standalone headless run (not under any session) is NOT absorbed", () => {
    const standalone = { sessionId: "B", pid: 500, live: true, headless: true };
    const { absorbed } = attributeBackground([A, standalone], tree({ 100: [], 500: [] }), new Map());
    expect(absorbed.size).toBe(0);
  });

  test("fd-link to a dead / non-interactive owner attributes nothing", () => {
    const { descByPid } = attributeBackground([A], tree({ 100: [] }), new Map([[300, "GHOST"]]));
    expect(descByPid.get(100)!.size).toBe(0);
  });

  test("fd-link is never routed to a headless owner (only interactive cards)", () => {
    const headlessOwner = { sessionId: "H", pid: 700, live: true, headless: true };
    const { descByPid } = attributeBackground(
      [A, headlessOwner], tree({ 100: [], 700: [] }), new Map([[800, "H"]]),
    );
    expect(descByPid.get(700)?.has(800)).toBeFalsy(); // H is headless — not an owner
  });

  test("an interactive owner is never absorbed, even if nested oddly", () => {
    const B = { sessionId: "B", pid: 500, live: true, headless: false }; // interactive
    const { absorbed } = attributeBackground([A, B], tree({ 100: [500], 500: [] }), new Map());
    expect(absorbed.size).toBe(0); // B is interactive — stays its own card
  });

  test("a multi-proc orphaned task: every linked pid joins the owner's set", () => {
    // wrapper exited; node + two agents reparented, all still fd-linked to A.
    const { descByPid } = attributeBackground(
      [A], tree({ 100: [] }), new Map([[610, "A"], [620, "A"], [630, "A"]]),
    );
    expect([...descByPid.get(100)!].sort()).toEqual([610, 620, 630]);
  });
});
