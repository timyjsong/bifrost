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

/** The --model flag from a live cmdline — carries the [1m] variant that
 *  per-message `message.model` drops. */
export function launchModelFromCmdline(args: string | undefined): string | undefined {
  return args?.match(/--model[= ](\S+)/)?.[1];
}

// Empirical window sizing (ported from tools/context-meter.py, kept in sync):
// the [1m] suffix means 1M; every base id means 200K — the only distinction
// that exists in practice for current Claude models.
const WIN_1M = 1_000_000;
const WIN_BASE = 200_000;

export interface ContextMeter {
  window: number;
  /** measured sources: model-log, launch-flag, last-model-usage; lookup = default, not measured */
  windowSrc: "model-log" | "launch-flag" | "last-model-usage" | "lookup";
  model?: string; // best current model id, variant-aware where known
}

/**
 * The context window for a model id or display name. Empirically pinned
 * 2026-06-11 (via /context on live switches + ~/.claude.json lastModelUsage):
 *   - the [1m] suffix or a "(1M context)" marker  => 1M
 *   - Fable 5 is 1M unconditionally (its only window; the picker doesn't even
 *     annotate it — a picker-selected bare "Fable 5" measured 967k free ≈ 1M)
 *   - Opus base / Sonnet / Haiku => 200K (no [1m] variant exists for the
 *     latter two in lastModelUsage)
 * Unknown future models fall to the safe 200K default.
 */
export function windowForModel(idOrName: string): number {
  const is1m = idOrName.includes("[1m]") || /\(1M context\)/i.test(idOrName);
  return is1m || /\bfable\b/i.test(idOrName) ? WIN_1M : WIN_BASE;
}

/**
 * Window from a "/model" command's stdout line, e.g.
 *   "Set model to \x1b[1mOpus 4.8 (1M context)\x1b[22m and saved …"   (picker)
 *   "Set model to \x1b[1mFable 5\x1b[22m and saved …"                 (picker/typed)
 * The ANSI bold code is literally "\x1b[1m" — strip escapes first, or the
 * styling reads as a [1m] variant marker on the wrong models. The display
 * name carries the model identity; windowForModel maps it to a size.
 */
export function windowFromModelLog(text: string): number | undefined {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  const m = clean.match(/Set model to ([^<\n]+)/);
  return m ? windowForModel(m[1]) : undefined;
}

/**
 * Resolve a live session's context window, switch-aware. Tiers, first wins:
 *  1. last /model switch logged in the transcript (exact, has variant)
 *  2. the --model launch flag from the live cmdline (exact at launch; any
 *     later switch produces a tier-1 line, so this can't go stale)
 *  3. ~/.claude.json lastModelUsage for the project — only when unambiguous
 *  4. base default 200K, labeled as a lookup
 */
export function resolveContextMeter(opts: {
  setWindow?: number; // from the last "/model" stdout line, last wins
  launchModel?: string; // from /proc cmdline --model
  msgModel?: string; // from the transcript tail's usage entries (base id)
  projectModels?: string[]; // lastModelUsage keys for the session's cwd
}): ContextMeter {
  const { setWindow, launchModel, msgModel, projectModels } = opts;
  const model = msgModel ?? launchModel;
  if (setWindow) {
    // the log decides the window; the transcript's usage entries name the
    // model (the display-format log line doesn't carry a usable id)
    const display =
      msgModel && setWindow === WIN_1M && !msgModel.endsWith("[1m]")
        ? `${msgModel}[1m]`
        : model;
    return { window: setWindow, windowSrc: "model-log", model: display };
  }
  if (launchModel) {
    // prefer the launch flag's variant-awareness, but a full id from the
    // transcript names the model better than a launch alias like "fable[1m]"
    const display =
      msgModel && launchModel.endsWith("[1m]") ? `${msgModel}[1m]` : (msgModel ?? launchModel);
    return { window: windowForModel(launchModel), windowSrc: "launch-flag", model: display };
  }
  const base = (msgModel ?? "").replace("[1m]", "");
  if (base && projectModels) {
    const has1m = projectModels.includes(`${base}[1m]`);
    const hasBase = projectModels.includes(base);
    if (has1m && !hasBase) {
      return { window: WIN_1M, windowSrc: "last-model-usage", model: `${base}[1m]` };
    }
    if (hasBase && !has1m) {
      return { window: windowForModel(base), windowSrc: "last-model-usage", model };
    }
  }
  return { window: WIN_BASE, windowSrc: "lookup", model };
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
