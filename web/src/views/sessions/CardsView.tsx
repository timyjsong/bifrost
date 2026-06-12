import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { SessionInfo, ChildProc } from "../../../../shared/types";
import { basename, fmtKb, fmtTokens, relTime, tildify } from "../../lib/format";
import { splitColumns, queueStatusOf, type QueueStatus } from "../../lib/selectors";
import { Bar, Chip, Dot, Panel } from "../../components/ui";
import { SummaryBlock } from "../../components/SummaryBlock";
import type { SessionsViewProps } from "./types";

/**
 * Where the session runs — one chip, most specific wins. tmux/ssh imply a
 * terminal, so the bare entrypoint label only shows when neither applies.
 */
function ResidenceChip({ s }: { s: SessionInfo }) {
  if (s.tmuxSession) {
    return (
      <Chip tone="tmux" mono>
        tmux {s.tmuxSession}
        {s.tmuxAttached ? "" : " · detached"}
      </Chip>
    );
  }
  if (s.overSsh) {
    return (
      <Chip tone="ssh" mono>
        ssh
      </Chip>
    );
  }
  if (s.entrypoint === "claude-desktop") return <Chip tone="desk">desktop</Chip>;
  if (s.entrypoint === "cli") return <Chip tone="mute">terminal</Chip>;
  return <Chip tone="mute">{s.entrypoint ?? "?"}</Chip>;
}

function shortModel(model?: string): string | undefined {
  return model?.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

// model pill: round + glyph + docked right — its own family, distinct from
// the square residence chips even where hues come close
const MODEL_GLYPHS: [RegExp, string, string][] = [
  [/fable/, "◆", "text-gold"],
  [/opus/, "●", "text-opus"],
  [/sonnet/, "▲", "text-sonnet"],
  [/haiku/, "○", "text-haiku"],
];

function ModelBadge({ model }: { model: string }) {
  const fam = MODEL_GLYPHS.find(([re]) => re.test(model));
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel-raised px-2 py-px font-mono text-[11px] leading-4 text-ink-dim">
      <span className={`text-[9px] ${fam ? fam[2] : "text-ink-mute"}`}>
        {fam ? fam[1] : "·"}
      </span>
      {shortModel(model)}
    </span>
  );
}

function fmtWindow(window: number): string {
  return window >= 1_000_000 ? `${window / 1_000_000}M` : `${window / 1_000}K`;
}

function ContextGauge({ s }: { s: SessionInfo }) {
  if (s.contextTokens === undefined) {
    return <div className="text-[11px] text-ink-mute">context —</div>;
  }
  const window = s.contextWindow ?? 200_000;
  const measured = s.contextWindowSrc !== undefined && s.contextWindowSrc !== "lookup";
  const ratio = s.contextTokens / window;
  return (
    <div className="flex items-center gap-2">
      <Bar
        ratio={ratio}
        tone={ratio > 0.75 ? "danger" : "gold"}
        className="w-24"
      />
      <span className="font-mono text-[11px] text-ink-mute tabular-nums">
        {fmtTokens(s.contextTokens)} / {measured ? "" : "~"}
        {fmtWindow(window)}
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
          <span
            className={`min-w-0 flex-1 truncate ${c.name ? "font-sans text-[12px] text-ink-dim" : "text-ink-dim"}`}
          >
            {c.name ?? c.command}
          </span>
          <span className="shrink-0 tabular-nums">
            pid {c.pid} · up {c.etime} · {fmtKb(c.rssKb)} rss
            {c.cpu >= 0.5
              ? ` · ${c.cpu < 10 ? c.cpu.toFixed(1) : c.cpu.toFixed(0)}% of box`
              : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function LiveCard({
  s,
  now,
  queueStatus,
}: {
  s: SessionInfo;
  now: number;
  queueStatus: QueueStatus;
}) {
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
            {s.customTitle ?? (basename(s.cwd) || s.cwd)}
          </span>
          <StateBadge s={s} now={now} />
          <ResidenceChip s={s} />
          {s.gitBranch && (
            <Chip tone="mute" mono>
              {s.gitBranch}
            </Chip>
          )}
          <span className="ml-auto flex items-center gap-2">
            {s.model && <ModelBadge model={s.model} />}
            <span className="font-mono text-[11px] text-ink-mute tabular-nums">
              pid {s.pid}
            </span>
          </span>
        </div>
        <div className="-mt-1 truncate font-mono text-[11px] text-ink-mute">
          {tildify(s.cwd)}
        </div>
        <ChildList children={s.children ?? []} />
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <ContextGauge s={s} />
          <span className="text-[11px] text-ink-mute">
            up {relTime(s.startedAt, now)} · active {relTime(s.lastActivityAt, now)}
          </span>
        </div>
        <SummaryBlock
          sessionId={s.sessionId}
          lastActivityAt={s.lastActivityAt}
          now={now}
          queueStatus={queueStatus}
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

export function CardsView({
  groups,
  now,
  summarize,
  isWide,
  filtersActive,
}: SessionsViewProps) {
  const { needsYou, working, liveHeadless } = groups;
  const cols = isWide ? 2 : 1;

  const cardGrid = (list: typeof needsYou) => (
    <div
      className={`grid items-start gap-3 ${isWide ? "grid-cols-2" : "grid-cols-1"}`}
    >
      {splitColumns(list, cols).map((col, i) => (
        <div key={i} className="space-y-3">
          <AnimatePresence mode="popLayout">
            {col.map((s) => (
              <LiveCard
                key={s.sessionId}
                s={s}
                now={now}
                queueStatus={queueStatusOf(s.sessionId, summarize)}
              />
            ))}
          </AnimatePresence>
        </div>
      ))}
    </div>
  );

  return (
    <div className="space-y-3">
      {needsYou.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-gold">
            <Dot tone="gold" pulse />
            needs you · {needsYou.length}
          </div>
          {cardGrid(needsYou)}
        </div>
      )}

      {working.length > 0 && (
        <div className={needsYou.length > 0 ? "pt-3" : ""}>
          <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-auto">
            <Dot tone="auto" pulse />
            in progress · {working.length}
          </div>
          {cardGrid(working)}
        </div>
      )}

      {needsYou.length === 0 && working.length === 0 && (
        <Panel className="px-4 py-6 text-center text-[13px] text-ink-mute">
          {filtersActive
            ? "no sessions match the filters"
            : "no interactive sessions running"}
        </Panel>
      )}

      <HeadlessGroup list={liveHeadless} now={now} />
    </div>
  );
}
