import { motion } from "motion/react";
import { useNow, useSnapshot } from "./lib/useSnapshot";
import { fmtKb, fmtUptime } from "./lib/format";
import { Dot } from "./components/ui";
import { SessionsPane } from "./components/SessionsPane";
import { ProjectsPane } from "./components/ProjectsPane";
import { SystemPane } from "./components/SystemPane";

const NAV = [
  { id: "sessions", label: "Sessions" },
  { id: "projects", label: "Projects" },
  { id: "system", label: "System" },
];

function scrollTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function Rail({ connected, host }: { connected: boolean; host: string }) {
  return (
    <aside className="fixed inset-y-0 left-0 hidden w-48 flex-col border-r border-line-soft px-6 py-8 lg:flex">
      <button onClick={scrollTop} className="select-none text-left" title="back to top">
        <div className="text-[15px] font-semibold tracking-[0.32em] text-ink">
          ATRIUM
        </div>
        <div className="mt-1 text-[11px] tracking-wide text-ink-mute">
          {host || "…"}
        </div>
      </button>
      <nav className="mt-12 flex flex-col gap-1">
        {NAV.map((n) => (
          <a
            key={n.id}
            href={`#${n.id}`}
            className="rounded-md px-2 py-1.5 text-[13px] text-ink-dim transition-colors hover:bg-panel-raised hover:text-ink"
          >
            {n.label}
          </a>
        ))}
      </nav>
      <div className="mt-auto flex items-center gap-2 text-[11px] text-ink-mute">
        <Dot tone={connected ? "gold" : "danger"} pulse={connected} />
        {connected ? "watching" : "reconnecting…"}
      </div>
    </aside>
  );
}

function Clock({ now }: { now: number }) {
  const d = new Date(now);
  return (
    <span className="font-mono text-[12px] text-ink-mute tabular-nums">
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

/**
 * Green→red gradient where the color tracks the percentage intuitively:
 * 0% green, ~50% orange, 100% red. Raw hue interpolation reads too green in
 * the middle (hue 70 still looks green), so anchor stops pin the midpoint
 * to true orange and lerp between them.
 */
function pressureColor(ratio: number): string {
  const r = Math.max(0, Math.min(1, ratio));
  const stops: [number, number][] = [
    [0, 140], // green
    [0.25, 95], // yellow-green
    [0.5, 38], // orange
    [0.75, 16], // red-orange
    [1, 0], // red
  ];
  let hue = 0;
  for (let i = 1; i < stops.length; i++) {
    const [r1, h1] = stops[i - 1];
    const [r2, h2] = stops[i];
    if (r <= r2) {
      hue = h1 + ((r - r1) / (r2 - r1)) * (h2 - h1);
      break;
    }
  }
  return `hsl(${hue} 52% 53%)`;
}

function StatChip({
  label,
  value,
  ratio,
}: {
  label: string;
  value: string;
  ratio?: number;
}) {
  return (
    <span className="text-[12px] text-ink-mute">
      {label}{" "}
      <span
        className="font-mono tabular-nums"
        style={ratio !== undefined ? { color: pressureColor(ratio) } : undefined}
      >
        {value}
      </span>
    </span>
  );
}

export default function App() {
  const { snap, connected } = useSnapshot();
  const now = useNow();

  if (!snap || !snap.generatedAt) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-[13px] tracking-[0.2em] text-ink-mute">
          ATRIUM <span className="pulse-dot inline-block">…</span>
        </div>
      </div>
    );
  }

  const liveCount = snap.sessions.filter((s) => s.live && !s.headless).length;
  const headlessCount = snap.sessions.filter((s) => s.live && s.headless).length;
  const needsYou = snap.sessions.filter(
    (s) => s.state === "awaiting" || s.state === "approval",
  ).length;
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
      <Rail connected={connected} host={snap.system.hostname} />
      <main className="mx-auto max-w-6xl px-5 py-8 lg:pl-60 lg:pr-10 xl:mx-0 xl:max-w-none 2xl:max-w-[1500px] 2xl:mx-auto">
        <motion.header
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mb-10 flex flex-wrap items-baseline gap-x-6 gap-y-2"
        >
          <button
            onClick={scrollTop}
            className="text-xl font-medium tracking-tight text-ink lg:hidden"
          >
            Atrium
          </button>
          <div className="flex items-center gap-2 text-[13px] text-ink-dim">
            <Dot tone={liveCount > 0 ? "gold" : "mute"} pulse={liveCount > 0} />
            {liveCount} interactive
            {headlessCount > 0 && (
              <span className="text-ink-mute">· {headlessCount} headless</span>
            )}
          </div>
          <StatChip
            label="cpu"
            value={sys.cpuPct !== undefined ? `${Math.round(sys.cpuPct)}%` : "—"}
            ratio={(sys.cpuPct ?? 0) / 100}
          />
          <StatChip
            label="mem"
            value={`${Math.round(memUsedRatio * 100)}%`}
            ratio={memUsedRatio}
          />
          <StatChip
            label="disk"
            value={`${(sys.disk.freeKb / 1024 / 1024).toFixed(0)}G free`}
            ratio={diskUsedRatio}
          />
          <StatChip
            label="claude"
            value={fmtKb(sys.claudeTotalRssKb)}
            ratio={claudeRatio}
          />
          <span className="text-[12px] text-ink-mute">
            up {fmtUptime(sys.uptimeSec)}
          </span>
          {needsYou > 0 && (
            <a
              href="#sessions"
              className="rounded-md border border-gold-dim/70 bg-gold/10 px-2 py-px text-[11px] font-medium text-gold transition-colors hover:bg-gold/20"
            >
              {needsYou} need{needsYou === 1 ? "s" : ""} you
            </a>
          )}
          <div className="ml-auto">
            <Clock now={now} />
          </div>
        </motion.header>

        <div className="space-y-12">
          <SessionsPane
            sessions={snap.sessions}
            now={now}
            summarize={snap.summarize}
          />
          <ProjectsPane projects={snap.projects} now={now} />
          <SystemPane system={snap.system} now={now} />
        </div>

        <footer className="mt-14 border-t border-line-soft pt-4 text-[11px] text-ink-mute">
          view-only by design — atrium watches, it doesn't poke
        </footer>
      </main>
    </div>
  );
}
