import { readFile } from "node:fs/promises";
import { statfsSync, readFileSync } from "node:fs";
import { hostname, cpus } from "node:os";
import type { SystemInfo, ProcInfo, TmuxInfo, PortInfo } from "../../shared/types";
import { cpuPctInstant, type TmuxPane } from "../derive";

async function run(cmd: string[], timeoutMs = 5000): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    await proc.exited;
    return out;
  } catch {
    return null;
  }
}

const CLAUDE_RE = /(^|\/| )(claude|ccd-cli)(\s|$|\/)/;

// pid -> last cumulative cpu-jiffies sample, for instantaneous CPU
const procCpu = new Map<number, { jiffies: number; at: number }>();

function readJiffies(pid: number): number | undefined {
  try {
    const statLine = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm (field 2) may contain spaces — parse after the closing paren.
    const after = statLine.slice(statLine.lastIndexOf(")") + 2).trimStart().split(" ");
    return Number(after[11]) + Number(after[12]); // utime + stime
  } catch {
    return undefined;
  }
}

const CORES = cpus().length;

/** Replace ps's lifetime-average %cpu with a since-last-tick, box-share measurement. */
function applyInstantCpu(all: ProcInfo[]): void {
  const now = Date.now();
  const seen = new Set<number>();
  for (const p of all) {
    seen.add(p.pid);
    const jiffies = readJiffies(p.pid);
    if (jiffies === undefined) {
      p.cpu = 0;
      continue;
    }
    const prev = procCpu.get(p.pid);
    procCpu.set(p.pid, { jiffies, at: now });
    p.cpu = prev
      ? cpuPctInstant(jiffies - prev.jiffies, now - prev.at, CORES)
      : 0;
  }
  for (const pid of procCpu.keys()) {
    if (!seen.has(pid)) procCpu.delete(pid);
  }
}

async function collectProcs(): Promise<{
  procs: ProcInfo[];
  claudeTotalRssKb: number;
  pidTree: [number, number][];
  allProcs: ProcInfo[];
}> {
  const out = await run([
    "ps", "axo", "pid=,ppid=,user=,rss=,pcpu=,etime=,tty=,args=", "--sort=-rss",
  ]);
  if (!out) return { procs: [], claudeTotalRssKb: 0, pidTree: [], allProcs: [] };

  const all: ProcInfo[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(.*)$/,
    );
    if (!m) continue;
    const command = m[8].trim();
    all.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      user: m[3],
      rssKb: Number(m[4]),
      cpu: Number(m[5]),
      etime: m[6],
      tty: m[7] === "?" ? undefined : m[7],
      command: command.length > 160 ? command.slice(0, 157) + "…" : command,
      isClaude: CLAUDE_RE.test(command),
    });
  }

  applyInstantCpu(all);

  const claude = all.filter((p) => p.isClaude);
  const claudeTotalRssKb = claude.reduce((s, p) => s + p.rssKb, 0);
  // Show every claude proc plus the heaviest non-claude ones; ps is rss-sorted already.
  const top = all.filter((p) => !p.isClaude).slice(0, 12);
  const procs = [...claude, ...top]
    .sort((a, b) => b.rssKb - a.rssKb)
    .slice(0, 30);
  const pidTree = all.map((p) => [p.pid, p.ppid] as [number, number]);
  return { procs, claudeTotalRssKb, pidTree, allProcs: all };
}

/**
 * Field separator for tmux `-F` formats. Deliberately NOT a tab: tmux replaces
 * control characters with `_` on the way out — 3.6 does it in format output, not
 * just in names — so a tab-separated format arrives as one unsplittable field.
 * Every lookup then returns nothing, which reads downstream as "there is no tmux
 * on this box" and silently gates the entire drive feature off.
 *
 * `:` is safe: tmux itself rewrites `:` to `_` in session names, so it cannot
 * occur inside that field, and the others here (a tty path and two integers)
 * can't contain one either.
 */
const TMUX_SEP = ":";

/** Pure: parse `tmux ls -F` output into session rows. */
export function parseTmuxSessions(raw: string): TmuxInfo[] {
  const sessions: TmuxInfo[] = [];
  for (const line of raw.split("\n")) {
    const [name, windows, created, attached] = line.split(TMUX_SEP);
    if (!name || windows === undefined) continue;
    sessions.push({
      name,
      windows: Number(windows),
      createdAt: Number(created) * 1000 || 0,
      attached: attached === "1",
    });
  }
  return sessions;
}

async function collectTmux(): Promise<TmuxInfo[]> {
  const out = await run([
    "tmux", "ls", "-F",
    `#{session_name}${TMUX_SEP}#{session_windows}${TMUX_SEP}#{session_created}${TMUX_SEP}#{session_attached}`,
  ]);
  if (!out) return [];
  return parseTmuxSessions(out);
}

/** Pure: parse `tmux list-panes -a -F` output into tty → session rows. */
export function parseTmuxPanes(raw: string): TmuxPane[] {
  const panes: TmuxPane[] = [];
  for (const line of raw.split("\n")) {
    const [tty, session, attached] = line.split(TMUX_SEP);
    if (!tty || !session) continue;
    // session_attached counts attached clients
    panes.push({ tty, session, attached: Number(attached) > 0 });
  }
  return panes;
}

/** Every pane's tty → tmux session, for matching processes into tmux. */
async function collectTmuxPanes(): Promise<TmuxPane[]> {
  const out = await run([
    "tmux", "list-panes", "-a", "-F",
    `#{pane_tty}${TMUX_SEP}#{session_name}${TMUX_SEP}#{session_attached}`,
  ]);
  if (!out) return [];
  return parseTmuxPanes(out);
}

async function collectPorts(): Promise<PortInfo[]> {
  const out = await run(["ss", "-tlnpH"]);
  if (!out) return [];
  const ports: PortInfo[] = [];
  const seen = new Set<string>();
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[3];
    const i = local.lastIndexOf(":");
    if (i < 0) continue;
    const addr = local.slice(0, i);
    const port = Number(local.slice(i + 1));
    if (!port) continue;
    const proc = line.match(/users:\(\("([^"]+)"/)?.[1];
    const key = `${addr}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ports.push({ addr, port, process: proc });
  }
  return ports.sort((a, b) => a.port - b.port);
}

// previous /proc/stat sample, for real CPU utilization between ticks
let prevCpu: { busy: number; total: number } | null = null;

function readCpuPct(statRaw: string): number | undefined {
  const f = statRaw.split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = f[3] + (f[4] ?? 0); // idle + iowait
  const total = f.reduce((a, b) => a + (b || 0), 0);
  const busy = total - idle;
  let pct: number | undefined;
  if (prevCpu && total > prevCpu.total) {
    pct = ((busy - prevCpu.busy) / (total - prevCpu.total)) * 100;
  }
  prevCpu = { busy, total };
  return pct === undefined ? undefined : Math.max(0, Math.min(100, pct));
}

function diskInfo(): { totalKb: number; freeKb: number } {
  try {
    const s = statfsSync("/");
    return {
      totalKb: Math.round((s.blocks * s.bsize) / 1024),
      freeKb: Math.round((s.bavail * s.bsize) / 1024),
    };
  } catch {
    return { totalKb: 0, freeKb: 0 };
  }
}

export interface SystemResult {
  info: SystemInfo;
  pidTree: [number, number][]; // [pid, ppid] for every process on the box
  allProcs: ProcInfo[]; // full ps snapshot, for per-session child details
  tmuxPanes: TmuxPane[]; // pane tty → tmux session, for session residence
}

export async function collectSystem(): Promise<SystemResult> {
  const [loadRaw, memRaw, uptimeRaw, statRaw, procsRes, tmux, tmuxPanes, ports] =
    await Promise.all([
      readFile("/proc/loadavg", "utf8"),
      readFile("/proc/meminfo", "utf8"),
      readFile("/proc/uptime", "utf8"),
      readFile("/proc/stat", "utf8"),
      collectProcs(),
      collectTmux(),
      collectTmuxPanes(),
      collectPorts(),
    ]);

  const load = loadRaw.split(" ").slice(0, 3).map(Number) as [number, number, number];

  const mem = { totalKb: 0, availKb: 0, swapTotalKb: 0, swapFreeKb: 0 };
  for (const line of memRaw.split("\n")) {
    const [key, val] = line.split(":");
    if (!val) continue;
    const kb = parseInt(val.trim(), 10);
    if (key === "MemTotal") mem.totalKb = kb;
    else if (key === "MemAvailable") mem.availKb = kb;
    else if (key === "SwapTotal") mem.swapTotalKb = kb;
    else if (key === "SwapFree") mem.swapFreeKb = kb;
  }

  return {
    info: {
      hostname: hostname(),
      uptimeSec: Math.floor(Number(uptimeRaw.split(" ")[0])),
      load,
      cpuPct: readCpuPct(statRaw),
      disk: diskInfo(),
      cores: cpus().length,
      mem,
      procs: procsRes.procs,
      claudeTotalRssKb: procsRes.claudeTotalRssKb,
      tmux,
      ports,
    },
    pidTree: procsRes.pidTree,
    allProcs: procsRes.allProcs,
    tmuxPanes,
  };
}
