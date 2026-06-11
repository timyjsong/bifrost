import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { SessionInfo, ChildProc } from "../../../shared/types";
import { basename, fmtKb, fmtTokens, relTime, tildify } from "../lib/format";
import { Bar, Chip, Dot, Panel, SectionTitle } from "./ui";
import { SummaryBlock } from "./SummaryBlock";

const CONTEXT_MAX = 1_000_000;

function entryLabel(s: SessionInfo): string {
  if (s.entrypoint === "claude-desktop") return "desktop";
  if (s.entrypoint === "cli") return "terminal";
  return s.entrypoint ?? "?";
}

function shortModel(model?: string): string | undefined {
  return model?.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function ContextGauge({ tokens }: { tokens?: number }) {
  if (tokens === undefined) {
    return <div className="text-[11px] text-ink-mute">context —</div>;
  }
  const ratio = tokens / CONTEXT_MAX;
  return (
    <div className="flex items-center gap-2">
      <Bar
        ratio={ratio}
        tone={ratio > 0.75 ? "danger" : "gold"}
        className="w-24"
      />
      <span className="font-mono text-[11px] text-ink-mute tabular-nums">
        {fmtTokens(tokens)} / 1M
      </span>
    </div>
  );
}

function StateBadge({ s, now }: { s: SessionInfo; now: number }) {
  if (s.state === "awaiting") {
    return (
      <span className="rounded-md border border-gold-dim/70 bg-gold/10 px-2 py-px text-[11px] font-medium text-gold">
        waiting {relTime(s.lastActivityAt, now)}
      </span>
    );
  }
  if (s.state === "approval") {
    return (
      <span className="rounded-md border border-danger/40 bg-danger/10 px-2 py-px text-[11px] text-danger">
        may need approval
      </span>
    );
  }
  if (s.state === "paused") {
    return (
      <Chip tone="mute">
        paused · {s.childProcs} proc{s.childProcs === 1 ? "" : "s"} out
      </Chip>
    );
  }
  if (s.state === "working") {
    return (
      <span className="rounded-md border border-auto/40 bg-auto/10 px-2 py-px text-[11px] text-auto">
        in progress{s.lastPromptAt ? ` ${relTime(s.lastPromptAt, now)}` : ""}
      </span>
    );
  }
  return null;
}

function ChildList({ children }: { children: ChildProc[] }) {
  if (children.length === 0) {
    return (
      <div className="flex items-baseline gap-2 font-mono text-[11px] text-ink-mute/70">
        <span>·</span>no subprocesses running
      </div>
    );
  }
  return (
    <ul className="space-y-1">
      {children.map((c) => (
        <li
          key={c.pid}
          className="flex items-baseline gap-2 font-mono text-[11px] text-ink-mute"
        >
          <span className="text-gold-dim">·</span>
          <span className="min-w-0 flex-1 truncate text-ink-dim">
            {c.command}
          </span>
          <span className="shrink-0 tabular-nums">
            pid {c.pid} · up {c.etime} · {fmtKb(c.rssKb)} rss
            {c.cpu > 0.5 ? ` · ${c.cpu.toFixed(0)}% cpu` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function LiveCard({ s, now }: { s: SessionInfo; now: number }) {
  const needsYou = s.state === "awaiting" || s.state === "approval";
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
    >
      <Panel
        className={`flex h-full flex-col gap-2.5 p-4 ${
          needsYou ? "border-gold-dim/60 bg-panel-raised" : ""
        }`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Dot
            tone={s.state === "approval" ? "danger" : needsYou ? "gold" : s.state === "paused" ? "mute" : "gold"}
            pulse={s.state !== "paused"}
          />
          <span className="truncate text-[15px] font-medium text-ink">
            {basename(s.cwd) || s.cwd}
          </span>
          <StateBadge s={s} now={now} />
          <Chip tone="mute">{entryLabel(s)}</Chip>
          {s.model && (
            <Chip tone="mute" mono>
              {shortModel(s.model)}
            </Chip>
          )}
          {s.gitBranch && (
            <Chip tone="mute" mono>
              {s.gitBranch}
            </Chip>
          )}
          <span className="ml-auto font-mono text-[11px] text-ink-mute tabular-nums">
            pid {s.pid}
          </span>
        </div>
        <ChildList children={s.children ?? []} />
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <ContextGauge tokens={s.contextTokens} />
          <span className="text-[11px] text-ink-mute">
            up {relTime(s.startedAt, now)} · active {relTime(s.lastActivityAt, now)}
          </span>
        </div>
        <SummaryBlock
          sessionId={s.sessionId}
          lastActivityAt={s.lastActivityAt}
          now={now}
        />
      </Panel>
    </motion.div>
  );
}

function HeadlessGroup({ list, now }: { list: SessionInfo[]; now: number }) {
  const [open, setOpen] = useState(false);
  if (list.length === 0) return null;
  return (
    <Panel className="overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-panel-raised"
      >
        <Dot tone="auto" pulse />
        <span className="text-[13px] text-ink-dim">
          {list.length} headless {list.length === 1 ? "run" : "runs"}
          <span className="text-ink-mute"> — sdk-driven automation</span>
        </span>
        <span className="ml-auto font-mono text-[11px] text-ink-mute">
          {open ? "−" : "+"}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
          >
            <div className="border-t border-line-soft">
              {list.map((s) => (
                <div
                  key={s.sessionId}
                  className="flex items-center gap-3 border-b border-line-soft px-4 py-2 text-[12px] last:border-b-0"
                >
                  <span className="font-mono text-ink-mute tabular-nums">
                    {s.pid}
                  </span>
                  <span className="truncate font-mono text-ink-mute">
                    {tildify(s.cwd)}
                  </span>
                  <span className="ml-auto shrink-0 text-ink-mute">
                    up {relTime(s.startedAt, now)}
                  </span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Panel>
  );
}

function RecentRow({ s, now }: { s: SessionInfo; now: number }) {
  return (
    <div className="border-b border-line-soft px-4 py-2.5 last:border-b-0">
      <div className="flex items-center gap-3">
        <span className="w-10 shrink-0 font-mono text-[11px] text-ink-mute tabular-nums">
          {relTime(s.lastActivityAt, now)}
        </span>
        <span className="w-36 shrink-0 truncate text-[12px] text-ink-dim">
          {basename(s.cwd) || "—"}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-mute">
          {s.title ?? "—"}
        </span>
        {s.model && (
          <Chip tone="mute" mono>
            {shortModel(s.model)}
          </Chip>
        )}
        {s.gitBranch && (
          <span className="hidden shrink-0 font-mono text-[11px] text-ink-mute md:inline">
            {s.gitBranch}
          </span>
        )}
        <span className="shrink-0 font-mono text-[11px] text-ink-mute tabular-nums">
          {fmtTokens(s.contextTokens)}
        </span>
      </div>
      <div className="mt-1.5 pl-13">
        <SummaryBlock
          sessionId={s.sessionId}
          lastActivityAt={s.lastActivityAt}
          now={now}
        />
      </div>
    </div>
  );
}

/** Track the xl breakpoint so live cards can pack into independent columns. */
function useIsWide(): boolean {
  const [wide, setWide] = useState(
    () => window.matchMedia("(min-width: 1280px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return wide;
}

export function SessionsPane({
  sessions,
  now,
}: {
  sessions: SessionInfo[];
  now: number;
}) {
  const isWide = useIsWide();
  const liveInteractive = sessions.filter((s) => s.live && !s.headless);
  // longest-waiting first — the most-forgotten session belongs on top
  const needsYou = liveInteractive
    .filter((s) => s.state === "awaiting" || s.state === "approval")
    .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
  const rest = liveInteractive.filter(
    (s) => s.state !== "awaiting" && s.state !== "approval",
  );
  // Two independently-packed stacks per section: an expanded card only pushes
  // its own column, never opening holes beside it (grid rows couple heights).
  const splitColumns = (list: SessionInfo[]) =>
    isWide
      ? [list.filter((_, i) => i % 2 === 0), list.filter((_, i) => i % 2 === 1)]
      : [list];
  const liveHeadless = sessions.filter((s) => s.live && s.headless);
  const recent = sessions.filter((s) => !s.live && !s.headless);
  const recentHeadless = sessions.filter((s) => !s.live && s.headless);
  const lastHeadlessAt = recentHeadless.reduce(
    (m, s) => Math.max(m, s.lastActivityAt),
    0,
  );
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? recent : recent.slice(0, 10);

  return (
    <section id="sessions" className="scroll-mt-8">
      <SectionTitle
        title="Sessions"
        hint={`${liveInteractive.length + liveHeadless.length} live · ${recent.length} recent`}
      />
      <div className="space-y-3">
        {needsYou.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-gold">
              <Dot tone="gold" pulse />
              needs you · {needsYou.length}
            </div>
            <div
              className={`grid items-start gap-3 ${isWide ? "grid-cols-2" : "grid-cols-1"}`}
            >
              {splitColumns(needsYou).map((col, i) => (
                <div key={i} className="space-y-3">
                  <AnimatePresence mode="popLayout">
                    {col.map((s) => (
                      <LiveCard key={s.sessionId} s={s} now={now} />
                    ))}
                  </AnimatePresence>
                </div>
              ))}
            </div>
          </div>
        )}

        {rest.length > 0 && (
          <div className={needsYou.length > 0 ? "pt-3" : ""}>
            <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-auto">
              <Dot tone="auto" pulse />
              in progress · {rest.length}
            </div>
            <div
              className={`grid items-start gap-3 ${isWide ? "grid-cols-2" : "grid-cols-1"}`}
            >
              {splitColumns(rest).map((col, i) => (
                <div key={i} className="space-y-3">
                  <AnimatePresence mode="popLayout">
                    {col.map((s) => (
                      <LiveCard key={s.sessionId} s={s} now={now} />
                    ))}
                  </AnimatePresence>
                </div>
              ))}
            </div>
          </div>
        )}

        {liveInteractive.length === 0 && (
          <Panel className="px-4 py-6 text-center text-[13px] text-ink-mute">
            no interactive sessions running
          </Panel>
        )}

        <HeadlessGroup list={liveHeadless} now={now} />

        {(recent.length > 0 || recentHeadless.length > 0) && (
          <Panel>
            <div className="border-b border-line-soft px-4 py-2 text-[11px] uppercase tracking-[0.14em] text-ink-mute">
              recent
            </div>
            {visible.map((s) => (
              <RecentRow key={s.sessionId} s={s} now={now} />
            ))}
            {recentHeadless.length > 0 && (
              <div className="flex items-center gap-3 border-b border-line-soft px-4 py-2.5 last:border-b-0">
                <span className="w-10 shrink-0 font-mono text-[11px] text-ink-mute tabular-nums">
                  {relTime(lastHeadlessAt, now)}
                </span>
                <span className="text-[12px] text-ink-mute">
                  {recentHeadless.length} headless runs, collapsed
                </span>
              </div>
            )}
            {recent.length > 10 && (
              <button
                onClick={() => setShowAll(!showAll)}
                className="w-full px-4 py-2 text-left text-[12px] text-ink-mute transition-colors hover:bg-panel-raised hover:text-ink-dim"
              >
                {showAll ? "show fewer" : `show all ${recent.length}`}
              </button>
            )}
          </Panel>
        )}
      </div>
    </section>
  );
}
