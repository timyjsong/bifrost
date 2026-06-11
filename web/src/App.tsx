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

function Rail({ connected, host }: { connected: boolean; host: string }) {
  return (
    <aside className="fixed inset-y-0 left-0 hidden w-48 flex-col border-r border-line-soft px-6 py-8 lg:flex">
      <div className="select-none">
        <div className="text-[15px] font-semibold tracking-[0.32em] text-ink">
          ATRIUM
        </div>
        <div className="mt-1 text-[11px] tracking-wide text-ink-mute">
          {host || "…"}
        </div>
      </div>
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
  return (
    <span className="font-mono text-[12px] text-ink-mute tabular-nums">
      {new Date(now).toLocaleTimeString(undefined, { hour12: false })}
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
          <h1 className="text-xl font-medium tracking-tight text-ink lg:hidden">
            Atrium
          </h1>
          <div className="flex items-center gap-2 text-[13px] text-ink-dim">
            <Dot tone={liveCount > 0 ? "gold" : "mute"} pulse={liveCount > 0} />
            {liveCount} interactive
            {headlessCount > 0 && (
              <span className="text-ink-mute">· {headlessCount} headless</span>
            )}
          </div>
          <span className="text-[12px] text-ink-mute">
            load{" "}
            <span className="font-mono tabular-nums">
              {snap.system.load[0].toFixed(2)}
            </span>
          </span>
          <span className="text-[12px] text-ink-mute">
            mem{" "}
            <span className="font-mono tabular-nums">
              {fmtKb(snap.system.mem.totalKb - snap.system.mem.availKb)}
            </span>
          </span>
          <span className="text-[12px] text-ink-mute">
            up {fmtUptime(snap.system.uptimeSec)}
          </span>
          <div className="ml-auto">
            <Clock now={now} />
          </div>
        </motion.header>

        <div className="space-y-12">
          <SessionsPane sessions={snap.sessions} now={now} />
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
