import { useEffect, useState } from "react";
import type { ParkStatus, SystemDiagnostics, SystemInfo } from "../../../shared/types";
import { fmtKb, fmtUptime, relTime } from "../lib/format";
import { buildDiagnostics, type DiagTone } from "../lib/diagnostics";
import { fetchParkStatus, summarizePark } from "../lib/park";
import { Bar, Chip, Dot, Panel, SectionTitle, Stat } from "./ui";

function ParkPanel({ now }: { now: number }) {
  const [status, setStatus] = useState<ParkStatus | null>(null);
  useEffect(() => {
    const load = () => void fetchParkStatus().then(setStatus).catch(() => {});
    load();
    const t = setInterval(load, 30_000); // low-frequency: the sweeper writes on the slow tick
    return () => clearInterval(t);
  }, []);
  if (!status) return null;

  const sum = summarizePark(status.entries);
  const windowH = Math.round(status.idleParkMs / 3_600_000);
  return (
    <Panel>
      <div className="flex items-baseline justify-between border-b border-line-soft px-4 py-2">
        <span className="text-[11px] uppercase tracking-[0.14em] text-ink-mute">
          idle-park
          <span className="ml-2 normal-case tracking-normal text-ink-mute/70">
            {status.enabled
              ? "armed — auto-parks idle sessions"
              : "observe-only — logs what it would park"}
          </span>
        </span>
        <Chip tone={status.enabled ? "gold" : "mute"}>
          {status.enabled ? "armed" : "disarmed"}
        </Chip>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line-soft px-4 py-2 text-[11.5px] text-ink-mute">
        <span>window {windowH}h</span>
        <span>
          {sum.sessionCount} session{sum.sessionCount === 1 ? "" : "s"} flagged
        </span>
        <span>{sum.observeCount} observe</span>
        <span className={sum.killCount ? "text-danger" : ""}>
          {sum.killCount} kill{sum.killCount === 1 ? "" : "s"}
        </span>
        {status.parkedCount > 0 && <span>{status.parkedCount} parked now</span>}
      </div>
      {status.entries.length === 0 && (
        <div className="px-4 py-4 text-[12px] text-ink-mute">
          nothing idle past the window yet
        </div>
      )}
      {status.entries.map((e, i) => (
        <div
          key={`${e.at}-${e.uuid}-${i}`}
          className="flex items-center gap-3 border-b border-line-soft px-4 py-2 text-[12px] last:border-b-0"
        >
          <Chip tone={e.mode === "kill" ? "danger" : "mute"}>{e.mode}</Chip>
          <span className="truncate text-ink-dim">{e.cwd.split("/").pop() || e.cwd}</span>
          <span className="font-mono text-[11px] text-ink-mute tabular-nums">
            idle {fmtUptime(Math.floor(e.idleMs / 1000))}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-mute/70 tabular-nums">
            {relTime(e.at, now)}
          </span>
        </div>
      ))}
    </Panel>
  );
}

const DOT_TONE: Record<DiagTone, "mute" | "gold" | "danger"> = {
  ok: "mute",
  warn: "gold",
  danger: "danger",
};

function Diagnostics({ diagnostics }: { diagnostics: SystemDiagnostics }) {
  const { rows, overall } = buildDiagnostics(diagnostics);
  const overallLabel =
    overall === "danger" ? "degraded" : overall === "warn" ? "warnings" : "healthy";
  return (
    <Panel>
      <div className="flex items-baseline justify-between border-b border-line-soft px-4 py-2">
        <span className="text-[11px] uppercase tracking-[0.14em] text-ink-mute">
          diagnostics
          <span className="ml-2 normal-case tracking-normal text-ink-mute/70">
            from the alert engine
          </span>
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-ink-mute">
          <Dot tone={DOT_TONE[overall]} pulse={overall === "danger"} />
          {overallLabel}
        </span>
      </div>
      {rows.map((r) => (
        <div
          key={r.key}
          className="flex items-center gap-3 border-b border-line-soft px-4 py-2 text-[12px] last:border-b-0"
        >
          <Dot tone={DOT_TONE[r.tone]} />
          <span className="w-36 shrink-0 text-ink-dim">{r.label}</span>
          <span
            className={`font-mono tabular-nums ${
              r.tone === "danger" ? "text-danger" : r.tone === "warn" ? "text-gold" : "text-ink-mute"
            }`}
          >
            {r.value}
          </span>
          {r.sub && (
            <span className="ml-auto truncate text-[11px] text-ink-mute/70">{r.sub}</span>
          )}
        </div>
      ))}
    </Panel>
  );
}

function ClaudeProcs({ system }: { system: SystemInfo }) {
  const claude = system.procs.filter((p) => p.isClaude);
  return (
    <Panel>
      <div className="flex items-baseline justify-between border-b border-line-soft px-4 py-2">
        <span className="text-[11px] uppercase tracking-[0.14em] text-ink-mute">
          claude processes
          <span className="ml-2 normal-case tracking-normal text-ink-mute/70">
            cpu = share of box
          </span>
        </span>
        <span className="font-mono text-[11px] text-ink-mute tabular-nums">
          Σ {fmtKb(system.claudeTotalRssKb)}
        </span>
      </div>
      {claude.length === 0 && (
        <div className="px-4 py-4 text-[12px] text-ink-mute">none running</div>
      )}
      {claude.map((p) => (
        <div
          key={p.pid}
          className="flex items-center gap-3 border-b border-line-soft px-4 py-2 text-[12px] transition-colors last:border-b-0 hover:bg-panel-raised/60"
        >
          <span className="w-14 shrink-0 font-mono text-ink-mute tabular-nums">
            {p.pid}
          </span>
          <span className="w-14 shrink-0 font-mono text-ink-dim tabular-nums">
            {fmtKb(p.rssKb)}
          </span>
          <span className="w-12 shrink-0 font-mono text-ink-mute tabular-nums">
            {p.cpu.toFixed(1)}%
          </span>
          <span className="truncate font-mono text-[11px] text-ink-mute">
            {p.command}
          </span>
        </div>
      ))}
    </Panel>
  );
}

function PortsAndTmux({ system, now }: { system: SystemInfo; now: number }) {
  return (
    <div className="space-y-3">
      <Panel>
        <div className="border-b border-line-soft px-4 py-2 text-[11px] uppercase tracking-[0.14em] text-ink-mute">
          tmux
        </div>
        {system.tmux.length === 0 && (
          <div className="px-4 py-3 text-[12px] text-ink-mute">no sessions</div>
        )}
        {system.tmux.map((t) => (
          <div
            key={t.name}
            className="flex items-center gap-3 border-b border-line-soft px-4 py-2 text-[12px] last:border-b-0"
          >
            <span className="font-mono text-ink-dim">{t.name}</span>
            <Chip tone="mute" mono>
              {t.windows}w
            </Chip>
            {t.attached && <Chip tone="gold">attached</Chip>}
            <span className="ml-auto font-mono text-[11px] text-ink-mute">
              {relTime(t.createdAt, now)}
            </span>
          </div>
        ))}
      </Panel>

      <Panel>
        <div className="border-b border-line-soft px-4 py-2 text-[11px] uppercase tracking-[0.14em] text-ink-mute">
          listening ports
        </div>
        <div className="grid grid-cols-2">
          {system.ports.map((p) => (
            <div
              key={`${p.addr}:${p.port}`}
              className="flex items-center gap-2 border-b border-line-soft px-4 py-1.5 text-[12px] last:border-b-0"
            >
              <span className="font-mono text-ink-dim tabular-nums">{p.port}</span>
              <span className="truncate font-mono text-[10px] text-ink-mute">
                {p.process ?? p.addr}
              </span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

export function SystemPane({
  system,
  diagnostics,
  now,
}: {
  system: SystemInfo;
  diagnostics?: SystemDiagnostics;
  now: number;
}) {
  const memUsed = system.mem.totalKb - system.mem.availKb;
  const memRatio = system.mem.totalKb ? memUsed / system.mem.totalKb : 0;
  const swapUsed = system.mem.swapTotalKb - system.mem.swapFreeKb;
  const loadRatio = system.cores ? system.load[0] / system.cores : 0;

  return (
    <section id="system" className="scroll-mt-[72px]">
      <SectionTitle title="System" hint={`up ${fmtUptime(system.uptimeSec)}`} />
      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="load"
          value={system.load[0].toFixed(2)}
          sub={`${system.load[1].toFixed(2)} / ${system.load[2].toFixed(2)} · ${system.cores} cores`}
        >
          <Bar
            ratio={loadRatio}
            tone={loadRatio > 0.85 ? "danger" : "gold"}
            className="mt-2"
          />
        </Stat>
        <Stat
          label="memory"
          value={`${fmtKb(memUsed)} / ${fmtKb(system.mem.totalKb)}`}
        >
          <Bar
            ratio={memRatio}
            tone={memRatio > 0.85 ? "danger" : "gold"}
            className="mt-2"
          />
        </Stat>
        <Stat
          label="swap"
          value={fmtKb(swapUsed)}
          sub={`of ${fmtKb(system.mem.swapTotalKb)}`}
        />
        <Stat
          label="claude rss"
          value={fmtKb(system.claudeTotalRssKb)}
          sub={`${system.procs.filter((p) => p.isClaude).length} processes`}
        />
      </div>
      {diagnostics && (
        <div className="mb-3">
          <Diagnostics diagnostics={diagnostics} />
        </div>
      )}
      <div className="mb-3">
        <ParkPanel now={now} />
      </div>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <ClaudeProcs system={system} />
        <PortsAndTmux system={system} now={now} />
      </div>
    </section>
  );
}
