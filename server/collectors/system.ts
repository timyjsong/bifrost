import { readFile } from "node:fs/promises";
import { hostname, cpus } from "node:os";
import type { SystemInfo, ProcInfo, TmuxInfo, PortInfo } from "../../shared/types";

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

async function collectProcs(): Promise<{ procs: ProcInfo[]; claudeTotalRssKb: number }> {
  const out = await run([
    "ps", "axo", "pid=,user=,rss=,pcpu=,etime=,args=", "--sort=-rss",
  ]);
  if (!out) return { procs: [], claudeTotalRssKb: 0 };

  const all: ProcInfo[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const command = m[6].trim();
    all.push({
      pid: Number(m[1]),
      user: m[2],
      rssKb: Number(m[3]),
      cpu: Number(m[4]),
      etime: m[5],
      command: command.length > 160 ? command.slice(0, 157) + "…" : command,
      isClaude: CLAUDE_RE.test(command),
    });
  }

  const claude = all.filter((p) => p.isClaude);
  const claudeTotalRssKb = claude.reduce((s, p) => s + p.rssKb, 0);
  // Show every claude proc plus the heaviest non-claude ones; ps is rss-sorted already.
  const top = all.filter((p) => !p.isClaude).slice(0, 12);
  const procs = [...claude, ...top]
    .sort((a, b) => b.rssKb - a.rssKb)
    .slice(0, 30);
  return { procs, claudeTotalRssKb };
}

async function collectTmux(): Promise<TmuxInfo[]> {
  const out = await run([
    "tmux", "ls", "-F",
    "#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}",
  ]);
  if (!out) return [];
  const sessions: TmuxInfo[] = [];
  for (const line of out.split("\n")) {
    const [name, windows, created, attached] = line.split("\t");
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

export async function collectSystem(): Promise<SystemInfo> {
  const [loadRaw, memRaw, uptimeRaw, procsRes, tmux, ports] = await Promise.all([
    readFile("/proc/loadavg", "utf8"),
    readFile("/proc/meminfo", "utf8"),
    readFile("/proc/uptime", "utf8"),
    collectProcs(),
    collectTmux(),
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
    hostname: hostname(),
    uptimeSec: Math.floor(Number(uptimeRaw.split(" ")[0])),
    load,
    cores: cpus().length,
    mem,
    procs: procsRes.procs,
    claudeTotalRssKb: procsRes.claudeTotalRssKb,
    tmux,
    ports,
  };
}
