import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { SessionInfo } from "../../../shared/types";
import { basename, fmtTokens, relTime, tildify } from "../lib/format";
import { Bar, Chip, Dot, Panel, SectionTitle } from "./ui";

const CONTEXT_MAX = 1_000_000;

function entryLabel(s: SessionInfo): string {
  if (s.entrypoint === "claude-desktop") return "desktop";
  if (s.entrypoint === "cli") return "terminal";
  return s.entrypoint ?? "?";
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

function LiveCard({ s, now }: { s: SessionInfo; now: number }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
    >
      <Panel className="flex h-full flex-col gap-2.5 p-4">
        <div className="flex items-center gap-2.5">
          <Dot tone="gold" pulse />
          <span className="truncate text-[15px] font-medium text-ink">
            {basename(s.cwd) || s.cwd}
          </span>
          <Chip tone="mute">{entryLabel(s)}</Chip>
          {s.model && (
            <Chip tone="mute" mono>
              {s.model.replace(/^claude-/, "").replace(/-\d{8}$/, "")}
            </Chip>
          )}
          <span className="ml-auto font-mono text-[11px] text-ink-mute tabular-nums">
            pid {s.pid}
          </span>
        </div>
        {s.title && (
          <p className="line-clamp-2 text-[13px] leading-relaxed text-ink-dim">
            {s.title}
          </p>
        )}
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
          <ContextGauge tokens={s.contextTokens} />
          <span className="text-[11px] text-ink-mute">
            up {relTime(s.startedAt, now)} · active {relTime(s.lastActivityAt, now)}
          </span>
        </div>
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
    <div className="flex items-center gap-3 border-b border-line-soft px-4 py-2.5 last:border-b-0">
      <span className="w-10 shrink-0 font-mono text-[11px] text-ink-mute tabular-nums">
        {relTime(s.lastActivityAt, now)}
      </span>
      <span className="w-36 shrink-0 truncate text-[12px] text-ink-dim">
        {basename(s.cwd) || "—"}
      </span>
      <span className="truncate text-[12px] text-ink-mute">{s.title ?? "—"}</span>
      <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-mute tabular-nums">
        {fmtTokens(s.contextTokens)}
      </span>
    </div>
  );
}

export function SessionsPane({
  sessions,
  now,
}: {
  sessions: SessionInfo[];
  now: number;
}) {
  const liveInteractive = sessions.filter((s) => s.live && !s.headless);
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
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          <AnimatePresence mode="popLayout">
            {liveInteractive.map((s) => (
              <LiveCard key={s.sessionId} s={s} now={now} />
            ))}
          </AnimatePresence>
          {liveInteractive.length === 0 && (
            <Panel className="px-4 py-6 text-center text-[13px] text-ink-mute xl:col-span-2">
              no interactive sessions running
            </Panel>
          )}
        </div>

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
