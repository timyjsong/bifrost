import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { SessionInfo, ChildProc } from "../../../../shared/types";
import { basename, fmtKb, fmtTokens, relTime, tildify } from "../../lib/format";
import {
  splitColumns,
  queueStatusOf,
  sessionAlertsEnabled,
  type QueueStatus,
} from "../../lib/selectors";
import { residenceOf } from "../../lib/sessionFilters";
import {
  groupChildren,
  gaugeModel,
  fmtWindow,
  stateStripe,
  glyphForModel,
  type StripeTone,
} from "../../lib/cardModel";
import { Chip, Dot, Panel } from "../../components/ui";
import { SummaryBlock } from "../../components/SummaryBlock";
import { AlertMuteToggle } from "../../components/AlertMuteToggle";
import type { SessionsViewProps } from "./types";

/**
 * Where the session runs — one chip, classified by the same residenceOf the
 * filter bar uses, so chip and filter can never disagree.
 */
function ResidenceChip({ s }: { s: SessionInfo }) {
  switch (residenceOf(s)) {
    case "tmux":
      return (
        <Chip tone="tmux" mono>
          tmux {s.tmuxSession}
          {s.tmuxAttached ? "" : " · detached"}
        </Chip>
      );
    case "ssh":
      return (
        <Chip tone="ssh" mono>
          ssh
        </Chip>
      );
    case "desktop":
      return <Chip tone="desk">desktop</Chip>;
    case "terminal":
      return <Chip tone="mute">terminal</Chip>;
    default:
      return <Chip tone="mute">{s.entrypoint ?? "?"}</Chip>;
  }
}

function shortModel(model?: string): string | undefined {
  return model?.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

// model pill: round + glyph + docked right — its own family, distinct from
// the square residence chips even where hues come close
function ModelBadge({ model }: { model: string }) {
  const fam = glyphForModel(model);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel-raised px-2 py-px font-mono text-[11px] leading-4 text-ink-dim">
      <span className={`text-[9px] ${fam.cls}`}>{fam.glyph}</span>
      {shortModel(model)}
    </span>
  );
}

function ContextGauge({ s }: { s: SessionInfo }) {
  const g = gaugeModel(s);
  if (!g) {
    return <div className="text-[11px] text-ink-mute">ctx —</div>;
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-[9.5px] uppercase tracking-[0.14em] text-ink-mute/70">
        ctx
      </span>
      <div className="relative h-[4px] w-28 overflow-hidden rounded-full bg-line-soft">
        <div
          className={`h-full rounded-full transition-[width] duration-700 ease-out ${
            g.danger ? "bg-danger/90" : "bg-gold/80"
          }`}
          style={{ width: `${g.ratio * 100}%` }}
        />
        {/* the 75% line — where a session starts needing a /clear plan */}
        <span className="absolute inset-y-0 left-3/4 w-px bg-bg" />
      </div>
      <span className="font-mono text-[11px] text-ink-mute tabular-nums">
        {fmtTokens(s.contextTokens)} / {g.measured ? "" : "~"}
        {fmtWindow(g.window)}
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
      <div className="border-l border-line-soft pl-3 font-mono text-[11px] text-ink-mute/60">
        no subprocesses running
      </div>
    );
  }
  return (
    <ul className="space-y-1.5 border-l border-line-soft pl-3">
      {groupChildren(children).map(({ c, n, rssKb, cpu }) => (
        <li
          key={c.pid}
          className="flex items-baseline gap-2 font-mono text-[11px] text-ink-mute"
        >
          <span
            className={`min-w-0 truncate ${c.name ? "font-sans text-[12px] text-ink-dim" : "text-ink-dim"}`}
          >
            {c.name ?? c.command}
          </span>
          {n > 1 && (
            <span className="shrink-0 rounded-full border border-line px-1.5 text-[10px] leading-4 text-ink-mute">
              ×{n}
            </span>
          )}
          <span className="ml-auto shrink-0 tabular-nums text-ink-mute/80">
            {n === 1 ? `pid ${c.pid} · up ${c.etime} · ` : ""}
            {fmtKb(rssKb)}
            {cpu >= 0.5
              ? ` · ${cpu < 10 ? cpu.toFixed(1) : cpu.toFixed(0)}% box`
              : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** State accent: a quiet architectural stripe down the card's left edge. */
const STRIPE_CLASSES: Record<StripeTone, string> = {
  danger: "bg-danger/70",
  gold: "bg-gold/70",
  mute: "bg-ink-mute/40",
  auto: "bg-auto/60",
};

function LiveCard({
  s,
  now,
  queueStatus,
  onOpen,
}: {
  s: SessionInfo;
  now: number;
  queueStatus: QueueStatus;
  onOpen: () => void;
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
        interactive
        className={`relative flex h-full flex-col gap-2.5 p-4 pl-5 ${
          needsYou ? "border-gold-dim/50 bg-panel-raised" : ""
        }`}
      >
        <span
          className={`absolute bottom-3 left-0 top-3 w-[2px] rounded-full ${STRIPE_CLASSES[stateStripe(s)]}`}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={onOpen}
            title="open the live session"
            className="truncate text-left text-[15px] font-medium leading-tight text-ink transition-colors hover:text-gold"
          >
            {s.customTitle ?? (basename(s.cwd) || s.cwd)}
          </button>
          <StateBadge s={s} now={now} />
          <span className="ml-auto flex items-center gap-2">
            {s.model && <ModelBadge model={s.model} />}
            <span className="font-mono text-[11px] text-ink-mute tabular-nums">
              {s.pid}
            </span>
            <AlertMuteToggle sessionId={s.sessionId} enabled={sessionAlertsEnabled(s)} />
          </span>
        </div>
        <div className="-mt-0.5 flex flex-wrap items-center gap-2">
          <ResidenceChip s={s} />
          {s.gitBranch && (
            <Chip tone="mute" mono>
              {s.gitBranch}
            </Chip>
          )}
          <span className="truncate font-mono text-[11px] text-ink-mute/80">
            {tildify(s.cwd)}
          </span>
        </div>
        <ChildList children={s.children ?? []} />
        <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
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
  onOpenDrive,
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
                onOpen={() => onOpenDrive(s.sessionId)}
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
