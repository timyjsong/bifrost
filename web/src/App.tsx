import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useNow, useSnapshot } from "./lib/useSnapshot";
import { fmtKb, fmtUptime } from "./lib/format";
import { pressureColor } from "./lib/pressure";
import { Dot } from "./components/ui";
import { SessionsPane } from "./components/SessionsPane";
import { ProjectsPane } from "./components/ProjectsPane";
import { SystemPane } from "./components/SystemPane";
import { AlertsPane } from "./components/AlertsPane";
import { SettingsPane } from "./components/SettingsPane";
import { Enroll } from "./components/Enroll";
import { DriveView } from "./components/DriveView";
import { getToken, AUTH_LOST_EVENT } from "./lib/api";

function scrollTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function Rail({
  connected,
  host,
  uptimeSec,
  counts,
  onNav,
}: {
  connected: boolean;
  host: string;
  uptimeSec: number;
  counts: { sessions: number; needsYou: number; projects: number };
  onNav: (id: string) => void;
}) {
  const nav = [
    { id: "sessions", label: "Sessions", count: counts.sessions, alert: counts.needsYou },
    { id: "system", label: "System", count: undefined, alert: 0 },
    { id: "alerts", label: "Alerts", count: undefined, alert: 0 },
    { id: "projects", label: "Projects", count: counts.projects, alert: 0 },
  ];
  return (
    <aside className="fixed inset-y-0 left-0 z-50 hidden w-48 flex-col border-r border-line-soft bg-bg/60 px-6 py-7 backdrop-blur-sm lg:flex">
      <button onClick={scrollTop} className="select-none text-left" title="back to top">
        <div className="text-[15px] font-semibold tracking-[0.32em] text-ink">
          BIFROST
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
            onClick={() => onNav(n.id)}
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

/** Mobile-only section switcher: a fixed tab strip under the command bar that
 *  shows which pane you're on and jumps to one on tap. Hidden at lg (the rail
 *  takes over). The swipe itself is native scroll-snap — this just indicates +
 *  shortcuts it. */
function MobileTabs({
  sections,
  active,
  onJump,
}: {
  sections: { id: string; label: string; alert: number }[];
  active: number;
  onJump: (i: number, id: string) => void;
}) {
  return (
    <nav className="fixed inset-x-0 top-[52px] z-30 flex border-b border-line-soft bg-bg/80 backdrop-blur-md lg:hidden">
      {sections.map((s, i) => (
        <button
          key={s.id}
          onClick={() => onJump(i, s.id)}
          className={`relative flex flex-1 items-center justify-center gap-1.5 py-2.5 text-[12px] font-medium tracking-wide transition-colors ${
            active === i ? "text-gold" : "text-ink-mute"
          }`}
        >
          {s.label}
          {s.alert > 0 && <Dot tone="gold" pulse />}
          {active === i && (
            <span className="absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-gold" />
          )}
        </button>
      ))}
    </nav>
  );
}

function Dashboard() {
  const { snap, connected } = useSnapshot();
  const now = useNow();

  const needsYou =
    snap?.sessions.filter(
      (s) => s.state === "awaiting" || s.state === "approval",
    ).length ?? 0;

  // the tab itself is a status surface
  useEffect(() => {
    document.title = needsYou > 0 ? `(${needsYou}) Bifrost` : "Bifrost";
  }, [needsYou]);

  // Mobile carousel: the horizontal scroll-snap track drives the active pane;
  // tapping a tab (or the needs-you pill) scrolls it. Inert on desktop, where
  // the track reverts to a vertical stack and these never fire.
  // Projects sits leftmost on mobile, but the carousel OPENS on Sessions — so
  // Sessions is the mobile visual index 1 (Projects 0, System 2, Alerts 3).
  const SESSIONS_PANE = 1;
  const trackRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(SESSIONS_PANE);
  const didInit = useRef(false);
  const onTrackScroll = () => {
    const el = trackRef.current;
    if (!el || !el.clientWidth) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    setActive((prev) => (prev === i ? prev : i));
  };
  const goToPane = (i: number) => {
    const el = trackRef.current;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
  };
  // The open project-file-browser, lifted here so the Projects nav (mobile tab
  // or desktop rail) can reset it to the grid — "back out to root".
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const onNav = (id: string) => {
    if (id === "projects") setBrowsePath(null);
  };
  // The open live drive view (Build 1). Lifted here so it overlays the whole
  // dashboard; closes itself if the session it points at ends.
  const [driveSessionId, setDriveSessionId] = useState<string | null>(null);
  const driveSession =
    snap?.sessions.find((s) => s.sessionId === driveSessionId) ?? null;
  useEffect(() => {
    if (driveSessionId && snap?.generatedAt && !driveSession) {
      setDriveSessionId(null); // the session ended — drop back to the dashboard
    }
  }, [driveSessionId, driveSession, snap?.generatedAt]);
  // Deep link: a push notification (or any /?session=<id> link) opens that
  // session's drive view straight away — tap the approval push, land where you
  // can answer (M8). Clean the URL so a manual refresh doesn't re-trigger.
  useEffect(() => {
    const sid = new URLSearchParams(window.location.search).get("session");
    if (sid) {
      setDriveSessionId(sid);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);
  // Open on the Sessions pane (before paint, so no flash of Projects). No-op on
  // desktop (block layout — scrollLeft clamps to 0, top of the stack shows).
  useLayoutEffect(() => {
    if (didInit.current) return;
    const el = trackRef.current;
    if (!el || !el.clientWidth) return;
    el.scrollLeft = SESSIONS_PANE * el.clientWidth;
    didInit.current = true;
  });

  if (!snap || !snap.generatedAt) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <div className="text-[13px] tracking-[0.32em] text-ink-mute">BIFROST</div>
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

  // Order is shared by the desktop stack, the rail, and the mobile swipe panes.
  const sections = [
    {
      id: "sessions",
      label: "Sessions",
      alert: needsYou,
      node: (
        <SessionsPane
          sessions={snap.sessions}
          now={now}
          summarize={snap.summarize}
          onOpenDrive={setDriveSessionId}
        />
      ),
    },
    { id: "system", label: "System", alert: 0, node: <SystemPane system={snap.system} now={now} /> },
    { id: "alerts", label: "Alerts", alert: 0, node: <AlertsPane /> },
    { id: "settings", label: "Settings", alert: 0, node: <SettingsPane /> },
    {
      id: "projects",
      label: "Projects",
      alert: 0,
      node: (
        <ProjectsPane
          projects={snap.projects}
          now={now}
          openPath={browsePath}
          onOpenChange={setBrowsePath}
        />
      ),
    },
  ];
  // Mobile tab/pane order puts Projects leftmost (desktop DOM order is untouched;
  // the Projects pane just gets `order-first` to float left under flex). Tabs and
  // the scroll index both follow this visual order.
  const mobileSections = [sections[sections.length - 1], ...sections.slice(0, -1)];

  return (
    <div className="min-h-screen">
      {driveSession && (
        <DriveView
          session={driveSession}
          onClose={() => setDriveSessionId(null)}
        />
      )}
      <Rail
        connected={connected}
        host={sys.hostname}
        uptimeSec={sys.uptimeSec}
        counts={{
          sessions: liveCount + headlessCount,
          needsYou,
          projects: snap.projects.length,
        }}
        onNav={onNav}
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
            BIFROST
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
                onClick={(e) => {
                  if (window.matchMedia("(max-width: 1023px)").matches) {
                    e.preventDefault();
                    goToPane(SESSIONS_PANE);
                  }
                }}
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

      <MobileTabs
        sections={mobileSections}
        active={active}
        onJump={(i, id) => {
          onNav(id);
          goToPane(i);
        }}
      />

      <main className="pt-[92px] lg:mx-auto lg:max-w-6xl lg:px-5 lg:pb-8 lg:pl-60 lg:pr-10 lg:pt-[76px] xl:mx-0 xl:max-w-none 2xl:mx-auto 2xl:max-w-[1500px]">
        {/* Mobile: a horizontal scroll-snap carousel, one full-screen pane per
            section, each with its own vertical scroll. Desktop (lg): reverts to
            the familiar vertical stack — same DOM, no double-mount. */}
        <div
          ref={trackRef}
          onScroll={onTrackScroll}
          className="flex h-[calc(100dvh-92px)] snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:block lg:h-auto lg:snap-none lg:space-y-14 lg:overflow-visible"
        >
          {sections.map((s) => (
            <section
              key={s.id}
              id={s.id}
              className={`h-full w-full shrink-0 snap-start snap-always overflow-y-auto overscroll-y-contain px-5 pb-10 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:h-auto lg:w-auto lg:shrink lg:overflow-visible lg:px-0 lg:pb-0 lg:pt-0 ${
                s.id === "projects" ? "order-first lg:order-none" : ""
              }`}
            >
              {s.node}
            </section>
          ))}
        </div>

        <footer className="mt-16 hidden items-baseline justify-between border-t border-line-soft pt-4 text-[11px] text-ink-mute lg:flex">
          <span>view-only by design — bifrost watches, it doesn't poke</span>
          <span className="font-mono text-[10.5px] text-ink-mute/60">
            {sys.hostname}
          </span>
        </footer>
      </main>
    </div>
  );
}

/** Auth gate: the dashboard mounts only once a device token exists. A 401 from
 *  any API call fires AUTH_LOST_EVENT, dropping back here to re-enroll. */
export default function App() {
  const [authed, setAuthed] = useState(() => !!getToken());
  useEffect(() => {
    // Ask the browser not to evict our storage — the device token lives in
    // localStorage, and an installed PWA silently losing it means a surprise
    // re-enroll. Best-effort: Chrome honors persist(); Safari/iOS support is
    // partial, but an installed home-screen PWA already gets durable storage.
    void navigator.storage?.persist?.();
    const onLost = () => setAuthed(false);
    window.addEventListener(AUTH_LOST_EVENT, onLost);
    return () => window.removeEventListener(AUTH_LOST_EVENT, onLost);
  }, []);
  if (!authed) return <Enroll onEnrolled={() => setAuthed(true)} />;
  return <Dashboard />;
}
