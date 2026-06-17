import { useEffect, useRef } from "react";
import type {
  ContentBlock,
  InteractionMessage,
  SessionInfo,
} from "../../../shared/types";
import { basename, tildify } from "../lib/format";
import { useSessionStream } from "../lib/useSessionStream";
import { Dot } from "./ui";

/** A one-line summary of a tool call's input, best-effort across tool shapes. */
function toolSummary(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url;
    if (typeof pick === "string") return pick;
    try {
      const s = JSON.stringify(o);
      return s.length > 120 ? s.slice(0, 117) + "…" : s;
    } catch {
      return "";
    }
  }
  return typeof input === "string" ? input : "";
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function Block({ b }: { b: ContentBlock }) {
  switch (b.kind) {
    case "thinking":
      return (
        <div className="border-l-2 border-line-soft pl-3 text-[12.5px] italic leading-relaxed text-ink-mute/80 whitespace-pre-wrap">
          {b.text}
        </div>
      );
    case "text":
      return (
        <div className="text-[13.5px] leading-relaxed text-ink-dim whitespace-pre-wrap">
          {b.text}
        </div>
      );
    case "tool_use":
      return (
        <div className="font-mono text-[12px] text-ink-mute">
          <span className="text-auto">→ {b.name}</span>{" "}
          <span className="text-ink-mute/80">{clip(toolSummary(b.input), 160)}</span>
        </div>
      );
    case "tool_result":
      return (
        <div
          className={`whitespace-pre-wrap border-l border-line-soft pl-3 font-mono text-[11.5px] leading-snug ${
            b.isError ? "text-danger/90" : "text-ink-mute/70"
          }`}
        >
          {clip(b.text.trim(), 600) || "(no output)"}
        </div>
      );
  }
}

function Message({ m }: { m: InteractionMessage }) {
  const isUser = m.role === "user";
  // tool_results arrive as a user-role message of tool_result blocks — render
  // those inline (no "you" bubble), distinct from a real user prompt.
  const isToolResult =
    isUser && m.blocks.every((b) => b.kind === "tool_result");

  if (isUser && !isToolResult) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg rounded-br-sm border border-gold-dim/40 bg-gold/[0.06] px-3.5 py-2 text-[13.5px] leading-relaxed text-ink whitespace-pre-wrap">
          {m.blocks.map((b, i) => (
            <Block key={i} b={b} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={m.isSidechain ? "ml-4 border-l border-auto/30 pl-3" : ""}>
      {m.isSidechain && (
        <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-auto/70">
          subagent
        </div>
      )}
      <div className="space-y-1.5">
        {m.blocks.map((b, i) => (
          <Block key={i} b={b} />
        ))}
      </div>
    </div>
  );
}

/**
 * The live single-session drive view (Build 1 / M2). Read-only for now: it
 * renders the transcript-derived conversation and stays live via the per-session
 * SSE. M3–M5 add the prompt box, the contextual stop button, and approve/deny
 * into the footer of this same shell.
 */
export function DriveView({
  session,
  onClose,
}: {
  session: SessionInfo;
  onClose: () => void;
}) {
  const { state, connected } = useSessionStream(session.sessionId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const msgCount = state?.messages.length ?? 0;

  // Stick to the latest as the conversation grows (live feel).
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [msgCount]);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-bg">
      <header className="flex items-center gap-3 border-b border-line-soft bg-bg/90 px-4 py-3 backdrop-blur-md">
        <button
          onClick={onClose}
          className="rounded-md border border-line px-2.5 py-1 text-[12px] text-ink-dim transition-colors hover:bg-panel-raised hover:text-ink"
          aria-label="back to dashboard"
        >
          ← back
        </button>
        <div className="min-w-0">
          <div className="truncate text-[14px] font-medium text-ink">
            {session.customTitle ?? (basename(session.cwd) || session.cwd)}
          </div>
          <div className="truncate font-mono text-[11px] text-ink-mute/80">
            {tildify(session.cwd)}
            {session.tmuxSession ? ` · tmux ${session.tmuxSession}` : ""}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-ink-mute">
          <Dot tone={connected ? "gold" : "danger"} pulse={connected} />
          {connected ? "live" : "reconnecting…"}
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl flex-1 space-y-4 overflow-y-auto px-4 py-5">
        {state === null && (
          <div className="pt-10 text-center text-[12px] text-ink-mute">loading…</div>
        )}
        {state?.messages.length === 0 && (
          <div className="pt-10 text-center text-[12px] text-ink-mute">
            no conversation yet
          </div>
        )}
        {state?.messages.map((m) => (
          <Message key={m.uuid} m={m} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
