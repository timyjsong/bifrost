/**
 * Pure derivation logic: process trees, child listings, and session activity
 * state. No I/O — everything takes plain data, so it's unit-testable and the
 * server entrypoint stays a thin shell.
 */
import type { SessionInfo, ProcInfo, ChildProc } from "../shared/types";
import type { SessionSignals } from "./collectors/sessions";

/** All descendant pids of a root, from a [pid, ppid] snapshot. */
export function descendantsOf(
  root: number,
  pidTree: [number, number][],
): Set<number> {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of pidTree) {
    let arr = children.get(ppid);
    if (!arr) children.set(ppid, (arr = []));
    arr.push(pid);
  }
  const found = new Set<number>();
  const stack = [root];
  while (stack.length) {
    for (const child of children.get(stack.pop()!) ?? []) {
      found.add(child);
      stack.push(child);
    }
  }
  return found;
}

/** Strip the shell-snapshot wrapper noise so the actual command shows. */
export function cleanCommand(cmd: string): string {
  const evalMatch = cmd.match(/eval '(.+)/);
  let c = evalMatch ? evalMatch[1] : cmd;
  c = c.replace(/\s+/g, " ").trim().replace(/'?\s*<\s*\/dev\/null$/, "");
  return c.length > 90 ? c.slice(0, 87) + "…" : c;
}

export interface ToolCall {
  command?: string;
  description?: string;
}

/** Collapse to lowercase alphanumerics — ps mangles control chars to "?" and
 * whitespace differs between transcript and cmdline, so compare on substance. */
export function canonCommand(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Recover the description the session gave a command, from the session's
 * rolling call index (canon command -> description; insertion = recency).
 * `texts` are the full /proc cmdlines of the child and its wrapper ancestors,
 * closest first: a leaf is a subcommand somewhere inside the call's command;
 * a shell-snapshot wrapper embeds the command after its preamble. Walking
 * the ancestors covers script indirection, where the leaf's args share no
 * text with the command that launched it.
 */
export function nameFromCallIndex(
  texts: string[],
  index: Map<string, string> | undefined,
): string | undefined {
  if (!index?.size) return undefined;
  const entries = [...index.entries()].reverse(); // newest call first
  for (const text of texts) {
    const t = canonCommand(text);
    if (t.length < 8) continue; // too generic to match safely
    const probe = t.slice(0, 48);
    for (const [cmd, desc] of entries) {
      if (t.includes(cmd.slice(0, 48)) || cmd.includes(probe)) return desc;
    }
  }
  return undefined;
}

/**
 * The leaf processes among a session's descendants — the actual work
 * (shell-snapshot bash wrappers are parents of the real command, so leaves
 * are what's worth showing).
 */
export function leafChildren(
  descendants: Set<number>,
  pidTree: [number, number][],
  allProcs: ProcInfo[],
): ChildProc[] {
  const parents = new Set(
    pidTree.filter(([pid]) => descendants.has(pid)).map(([, ppid]) => ppid),
  );
  return allProcs
    .filter((p) => descendants.has(p.pid) && !parents.has(p.pid))
    .sort((a, b) => b.cpu - a.cpu || b.rssKb - a.rssKb)
    .slice(0, 6)
    .map((p) => ({
      pid: p.pid,
      etime: p.etime,
      rssKb: p.rssKb,
      cpu: p.cpu,
      command: cleanCommand(p.command),
    }));
}

/**
 * Instantaneous CPU from cumulative jiffies sampled twice, as a share of the
 * whole box: all `cores` together = 100. USER_HZ is fixed at 100 on Linux,
 * so one jiffy = 10ms of CPU. ps's %cpu is a per-core lifetime average — a
 * process that worked hard at startup reads high forever; this is what the
 * process did since the last tick, on the same scale as the header gauge.
 */
export function cpuPctInstant(
  deltaJiffies: number,
  deltaMs: number,
  cores = 1,
): number {
  if (deltaJiffies <= 0 || deltaMs <= 0 || cores <= 0) return 0;
  const pct = (deltaJiffies * 10 * 100) / deltaMs / cores;
  return Math.min(100, Math.round(pct * 10) / 10);
}

/**
 * Print-mode (claude -p / --print) cmdline — headless automation even when
 * the pid file and transcript claim an interactive kind/entrypoint, which
 * desktop-spawned background agents do.
 */
export function isPrintCmdline(args: string | undefined): boolean {
  if (!args) return false;
  return args.split(/\s+/).some((t) => t === "-p" || t === "--print");
}

export interface TmuxPane {
  tty: string; // "/dev/pts/2"
  session: string;
  attached: boolean;
}

export interface SessionVia {
  tmuxSession?: string;
  tmuxAttached?: boolean;
  overSsh?: boolean;
}

/**
 * Where a session lives: inside a tmux pane (matched by controlling tty —
 * robust where the launch-time TMUX/SSH env vars go stale), or hanging off
 * a live sshd (dies with the connection). Desktop-remote sessions match
 * neither — their server is reparented to init.
 */
export function deriveVia(
  pid: number,
  allProcs: ProcInfo[],
  panes: TmuxPane[],
): SessionVia {
  const byPid = new Map(allProcs.map((p) => [p.pid, p]));
  const me = byPid.get(pid);
  if (!me) return {};
  if (me.tty) {
    const pane = panes.find((p) => p.tty === `/dev/${me.tty}`);
    if (pane) return { tmuxSession: pane.session, tmuxAttached: pane.attached };
  }
  // No pane — walk ancestors for a live sshd ("sshd: user@pts/N").
  let cur = me;
  for (let hops = 0; hops < 50 && cur.ppid > 1; hops++) {
    const parent = byPid.get(cur.ppid);
    if (!parent) break;
    if (/^(\/\S*\/)?sshd\b/.test(parent.command)) return { overSsh: true };
    cur = parent;
  }
  return {};
}

/**
 * Derive a live interactive session's activity state from its signals.
 * Disk (transcript tail) is primary; children/CPU corroborate; the pid-file
 * status only demotes a false "awaiting" when it freshly says busy.
 */
export function deriveState(
  s: SessionInfo,
  sig: SessionSignals,
  childProcs: number,
): SessionInfo["state"] {
  if (!s.live || s.headless || sig.kind === "bg") return undefined;
  const statusFresh =
    sig.pidStatusAgeMs !== undefined && sig.pidStatusAgeMs < 15_000;
  if (sig.lastEntry === "assistant_done" && sig.openTools === 0) {
    if (statusFresh && (sig.pidStatus === "busy" || sig.pidStatus === "shell")) {
      return "working";
    }
    return childProcs > 0 ? "paused" : "awaiting";
  }
  if (
    sig.openTools > 0 &&
    childProcs === 0 &&
    (sig.cpuQuietMs ?? 0) > 10_000 &&
    !(statusFresh && sig.pidStatus === "busy")
  ) {
    return "approval";
  }
  return "working";
}
