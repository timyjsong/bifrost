import { useState } from "react";
import type { SessionInfo } from "../../../../shared/types";
import { basename, fmtTokens, relTime } from "../../lib/format";
import { queueStatusOf } from "../../lib/selectors";
import { Bar, Dot, Panel } from "../../components/ui";
import { SummaryBlock } from "../../components/SummaryBlock";
import type { SessionsViewProps } from "./types";

function stateLabel(s: SessionInfo, now: number): { text: string; cls: string } {
  switch (s.state) {
    case "awaiting":
      return { text: `waiting ${relTime(s.lastActivityAt, now)}`, cls: "text-gold" };
    case "approval":
      return { text: "approval?", cls: "text-danger" };
    case "paused":
      return { text: `paused · ${s.childProcs}p`, cls: "text-ink-dim" };
    default:
      return { text: "in progress", cls: "text-auto" };
  }
}

function Row({
  s,
  now,
  summarize,
}: {
  s: SessionInfo;
  now: number;
  summarize: SessionsViewProps["summarize"];
}) {
  const [open, setOpen] = useState(false);
  const st = stateLabel(s, now);
  const needsYou = s.state === "awaiting" || s.state === "approval";
  return (
    <div
      className={`border-b border-line-soft last:border-b-0 ${needsYou ? "bg-gold/[0.04]" : ""}`}
    >
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-panel-raised"
      >
        <Dot
          tone={
            !s.live
              ? "mute"
              : s.state === "approval"
                ? "danger"
                : needsYou
                  ? "gold"
                  : s.state === "paused"
                    ? "mute"
                    : "auto"
          }
          pulse={s.live && s.state !== "paused"}
        />
        <span className="w-36 shrink-0 truncate text-[13px] font-medium text-ink">
          {s.customTitle ?? (basename(s.cwd) || s.cwd)}
        </span>
        <span className={`w-28 shrink-0 text-[11px] ${st.cls}`}>{st.text}</span>
        <span className="hidden w-24 shrink-0 lg:block">
          {s.contextTokens !== undefined && (
            <Bar
              ratio={s.contextTokens / (s.contextWindow ?? 200_000)}
              tone={
                s.contextTokens / (s.contextWindow ?? 200_000) > 0.75
                  ? "danger"
                  : "gold"
              }
            />
          )}
        </span>
        <span className="w-14 shrink-0 font-mono text-[11px] text-ink-mute tabular-nums">
          {fmtTokens(s.contextTokens)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-mute">
          {s.children?.length
            ? s.children.map((c) => c.name ?? c.command).join(" · ")
            : (s.title ?? "—")}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-ink-mute tabular-nums">
          {s.live ? `pid ${s.pid}` : ""}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-2.5 pl-9">
          <SummaryBlock
            sessionId={s.sessionId}
            lastActivityAt={s.lastActivityAt}
            now={now}
            queueStatus={queueStatusOf(s.sessionId, summarize)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Dense single-table view: every session is one row, needs-you tinted gold
 * and pinned on top. Same data as cards, different shape — proof the view
 * layer swaps freely.
 */
export function TableView({ groups, now, summarize }: SessionsViewProps) {
  const { needsYou, working, liveHeadless } = groups;
  const ordered = [...needsYou, ...working];
  return (
    <Panel>
      {ordered.map((s) => (
        <Row key={s.sessionId} s={s} now={now} summarize={summarize} />
      ))}
      {ordered.length === 0 && (
        <div className="px-4 py-6 text-center text-[13px] text-ink-mute">
          no interactive sessions running
        </div>
      )}
      {liveHeadless.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-2 text-[12px] text-ink-mute">
          <Dot tone="auto" pulse />
          {liveHeadless.length} headless running
        </div>
      )}
    </Panel>
  );
}
