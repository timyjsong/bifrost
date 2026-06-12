import { useEffect } from "react";
import { motion } from "motion/react";
import { useNow, useSnapshot } from "./lib/useSnapshot";
import { fmtKb, fmtUptime } from "./lib/format";
import { pressureColor } from "./lib/pressure";
import { Dot } from "./components/ui";
import { SessionsPane } from "./components/SessionsPane";
import { ProjectsPane } from "./components/ProjectsPane";
import { SystemPane } from "./components/SystemPane";

function scrollTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function Rail({
  connected,
  host,
  uptimeSec,
  counts,
}: {
  connected: boolean;
  host: string;
  uptimeSec: number;
  counts: { sessions: number; needsYou: number; projects: number };
}) {
  const nav = [
    { id: "sessions", label: "Sessions", count: counts.sessions, alert: counts.needsYou },
    { id: "projects", label: "Projects", count: counts.projects, alert: 0 },
    { id: "system", label: "System", count: undefined, alert: 0 },
  ];
  return (
    <aside className="fixed inset-y-0 left-0 z-50 hidden w-48 flex-col border-r border-line-soft bg-bg/60 px-6 py-7 backdrop-blur-sm lg:flex">
      <button onClick={scrollTop} className="select-none text-left" title="back to top">
        <div className="text-[15px] font-semibold tracking-[0.32em] text-ink">
          ATRIUM
        </div>
        <div className="mt-2 h-px w-7 bg-gold/70" />
        <div className="mt-2 text-[11px] tracking-wide text-ink-mute">
          {host || "…"}
        </div>
      </button>
      <nav className="mt-10 flex flex-col gap-0.5">
        {nav.map((n) => (
          <a
            key={n.id}
            href={`#${n.id}`}
            className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink-dim transition-colors hover:bg-panel-raised hover:text-ink"
          >
            {n.label}
            {n.alert > 0 && <Dot tone="gold" pulse />}
            <span className="ml-auto font-mono text-[10.5px] text-ink-mute tabular-nums">
              {n.count ?? ""}
            </span>
          </a>
        ))}
      </nav>
      <div className="mt-auto space-y-1.5 text-[11px] text-ink-mute">
        <div className="flex items-center gap-2">
          <Dot tone={connected ? "gold" : "danger"} pulse={connected} />
          {connected ? "watching" : "reconnecting…"}
        </div>
        <div className="pl-[15px] font-mono text-[10.5px] text-ink-mute/70">
          up {fmtUptime(uptimeSec)}
        </div>
      </div>
    </aside>
  );
}

function Clock({ now }: { now: number }) {
  const d = new Date(now);
  return (
    <span className="font-mono text-[11.5px] text-ink-mute tabular-nums">
      {d.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      })}
      <span className="mx-1.5 text-ink-mute/50">·</span>
      {d.toLocaleTimeString(undefined, { hour12: false })}
    </span>
  );
}

/** One compact gauge in the command bar: label, live value, pressure meter.
 *  The bar always shows USED pressure; `suffix` lets a value read as "free". */
function Meter({
  label,
  value,
  suffix,
  ratio,
}: {
  label: string;
  value: string;
  suffix?: string;
  ratio?: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-1.5 whitespace-nowrap">
        <span className="text-[9.5px] uppercase tracking-[0.16em] text-ink-mute">
          {label}
        </span>
        <span
          className="font-mono text-[11.5px] leading-none tabular-nums"
          style={ratio !== undefined ? { color: pressureColor(ratio) } : undefined}
        >
          {value}
        </span>
        {suffix && (
          <span className="text-[9.5px] leading-none text-ink-mute/70">
            {suffix}
          </span>
        )}
      </div>
      <div className="h-[2px] w-full overflow-hidden rounded-full bg-line-soft">
        {ratio !== undefined && (
          <div
            className="h-full rounded-full transition-[width] duration-700 ease-out"
            style={{
              width: `${Math.max(2, Math.min(1, ratio) * 100)}%`,
              background: pressureColor(ratio),
              opacity: 0.75,
            }}
          />
        )}
      </div>
    </div>
  );
}

export default function App() {
  const { snap, connected } = useSnapshot();
  const now = useNow();

  const needsYou =
    snap?.sessions.filter(
      (s) => s.state === "awaiting" || s.state === "approval",
    ).length ?? 0;

  // the tab itself is a status surface
  useEffect(() => {
    document.title = needsYou > 0 ? `(${needsYou}) Atrium` : "Atrium";
  }, [needsYou]);

  if (!snap || !snap.generatedAt) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <div className="text-[13px] tracking-[0.32em] text-ink-mute">ATRIUM</div>
        <div className="h-px w-7 bg-gold/60" />
        <div className="pulse-dot text-[11px] text-ink-mute/60">waking…</div>
      </div>
    );
  }

  const liveCount = snap.sessions.filter((s) => s.live && !s.headless).length;
  const headlessCount = snap.sessions.filter((s) => s.live && s.headless).length;
  const sys = snap.system;
  const memUsedRatio = sys.mem.totalKb
    ? (sys.mem.totalKb - sys.mem.availKb) / sys.mem.totalKb
    : 0;
  const diskUsedRatio = sys.disk.totalKb
    ? (sys.disk.totalKb - sys.disk.freeKb) / sys.disk.totalKb
    : 0;
  const claudeRatio = sys.mem.totalKb
    ? sys.claudeTotalRssKb / sys.mem.totalKb
    : 0;

  return (
    <div className="min-h-screen">
      <Rail
        connected={connected}
        host={sys.hostname}
        uptimeSec={sys.uptimeSec}
        counts={{
          sessions: liveCount + headlessCount,
          needsYou,
          projects: snap.projects.length,
        }}
      />

      {/* command bar — fixed product chrome, glass over the page */}
      <motion.header
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="fixed inset-x-0 top-0 z-40 border-b border-line-soft bg-bg/75 backdrop-blur-md lg:left-48"
      >
        <div className="mx-auto flex h-[52px] max-w-6xl items-center gap-5 px-5 lg:mx-0 lg:max-w-none lg:pl-12 lg:pr-10 2xl:mx-auto 2xl:max-w-[1500px]">
          <button
            onClick={scrollTop}
            className="text-[14px] font-semibold tracking-[0.24em] text-ink lg:hidden"
          >
            ATRIUM
          </button>
          <div className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[12.5px] text-ink-dim">
            <Dot tone={liveCount > 0 ? "gold" : "mute"} pulse={liveCount > 0} />
            <span className="font-mono tabular-nums">{liveCount}</span> live
            {headlessCount > 0 && (
              <span className="hidden text-ink-mute xl:inline">
                · <span className="font-mono tabular-nums">{headlessCount}</span>{" "}
                headless
              </span>
            )}
          </div>
          <div className="hidden items-center gap-5 sm:flex">
            <div className="w-20">
              <Meter
                label="cpu"
                value={sys.cpuPct !== undefined ? `${Math.round(sys.cpuPct)}%` : "—"}
                ratio={(sys.cpuPct ?? 0) / 100}
              />
            </div>
            <div className="w-24">
              <Meter
                label="mem"
                value={fmtKb(sys.mem.availKb)}
                suffix="free"
                ratio={memUsedRatio}
              />
            </div>
            <div className="hidden w-24 lg:block">
              <Meter
                label="disk"
                value={`${(sys.disk.freeKb / 1024 / 1024).toFixed(0)}G`}
                suffix="free"
                ratio={diskUsedRatio}
              />
            </div>
            <div className="hidden w-24 xl:block">
              <Meter
                label="claude"
                value={fmtKb(sys.claudeTotalRssKb)}
                suffix="rss"
                ratio={claudeRatio}
              />
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-4 whitespace-nowrap">
            {needsYou > 0 && (
              <a
                href="#sessions"
                className="rounded-full border border-gold-dim/70 bg-gold/10 px-2.5 py-0.5 text-[11px] font-medium text-gold transition-colors hover:bg-gold/20"
              >
                {needsYou} need{needsYou === 1 ? "s" : ""} you
              </a>
            )}
            <span className="hidden md:block">
              <Clock now={now} />
            </span>
          </div>
        </div>
      </motion.header>

      <main className="mx-auto max-w-6xl px-5 pb-8 pt-[76px] lg:pl-60 lg:pr-10 xl:mx-0 xl:max-w-none 2xl:mx-auto 2xl:max-w-[1500px]">
        <div className="space-y-14">
          <SessionsPane
            sessions={snap.sessions}
            now={now}
            summarize={snap.summarize}
          />
          <ProjectsPane projects={snap.projects} now={now} />
          <SystemPane system={snap.system} now={now} />
        </div>

        <footer className="mt-16 flex items-baseline justify-between border-t border-line-soft pt-4 text-[11px] text-ink-mute">
          <span>view-only by design — atrium watches, it doesn't poke</span>
          <span className="font-mono text-[10.5px] text-ink-mute/60">
            {sys.hostname}
          </span>
        </footer>
      </main>
    </div>
  );
}
