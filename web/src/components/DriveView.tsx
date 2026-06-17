import { useEffect, useRef, useState } from "react";
import type {
  ContentBlock,
  InteractionMessage,
  InteractionState,
  SessionInfo,
} from "../../../shared/types";
import { basename, tildify } from "../lib/format";
import { useSessionStream } from "../lib/useSessionStream";
import { promptGate, sendPrompt, getDraft, saveDraft } from "../lib/drive";
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

/** Count real user PROMPTS (not tool_result lines) — the reconcile signal: a
 *  committed prompt adds exactly one, which clears the optimistic echo. */
function userPromptCount(st: InteractionState | null): number {
  if (!st) return 0;
  return st.messages.filter(
    (m) => m.role === "user" && !m.blocks.every((b) => b.kind === "tool_result"),
  ).length;
}

function Block({ b }: { b: ContentBlock }) {
  switch (b.kind) {
    case "thinking":
      return (
        <div className="whitespace-pre-wrap border-l-2 border-line-soft pl-3 text-[12.5px] italic leading-relaxed text-ink-mute/80">
          {b.text}
        </div>
      );
    case "text":
      return (
        <div className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink-dim">
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
  const isToolResult = isUser && m.blocks.every((b) => b.kind === "tool_result");

  if (isUser && !isToolResult) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-br-sm border border-gold-dim/40 bg-gold/[0.06] px-3.5 py-2 text-[13.5px] leading-relaxed text-ink">
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
 * The live single-session drive view (Build 1). M2 rendered it read-only; M3 adds
 * the prompt box: local-echo input, cross-device draft sync, commit-to-send with an
 * optimistic echo that reconciles against the transcript, and warn-and-allow gating.
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

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null); // optimistic echo
  const pendingBase = useRef(0); // user-prompt count at send time
  const skipSave = useRef(true); // don't persist the freshly-loaded draft back
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const gate = promptGate(session);

  // Stick to the latest as the conversation grows (live feel).
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [msgCount, pending]);

  // Load the cross-device draft when the session opens.
  useEffect(() => {
    let alive = true;
    void getDraft(session.sessionId).then((d) => {
      if (alive) {
        skipSave.current = true;
        setText(d);
      }
    });
    return () => {
      alive = false;
    };
  }, [session.sessionId]);

  // Persist edits (debounced) so the draft follows the user across devices.
  useEffect(() => {
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => void saveDraft(session.sessionId, text), 500);
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [text, session.sessionId]);

  // Reconcile the optimistic echo: once the transcript shows the new prompt
  // (the user-prompt count grew past the send-time base), drop the echo so the
  // message isn't rendered twice (AC3.4).
  useEffect(() => {
    if (pending !== null && userPromptCount(state) > pendingBase.current) {
      setPending(null);
    }
  }, [state, pending]);

  const send = async () => {
    const t = text.trim();
    if (!gate.canSend || !t || sending) return;
    setSending(true);
    setError(null);
    pendingBase.current = userPromptCount(state);
    const res = await sendPrompt(session.sessionId, text);
    setSending(false);
    if (res.ok) {
      setPending(text); // optimistic until the transcript confirms
      skipSave.current = true; // server already cleared the draft on send
      setText("");
    } else {
      setError(res.reason ?? "send failed"); // loud failure — the draft is preserved
    }
  };

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
        {state?.messages.length === 0 && pending === null && (
          <div className="pt-10 text-center text-[12px] text-ink-mute">
            no conversation yet
          </div>
        )}
        {state?.messages.map((m) => (
          <Message key={m.uuid} m={m} />
        ))}
        {pending !== null && (
          <div className="flex justify-end">
            <div className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-br-sm border border-gold-dim/30 bg-gold/[0.04] px-3.5 py-2 text-[13.5px] leading-relaxed text-ink/70">
              {pending}
              <span className="ml-2 align-middle text-[10px] text-ink-mute">sending…</span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <footer className="border-t border-line-soft bg-bg/90 px-4 py-3">
        <div className="mx-auto w-full max-w-4xl">
          {gate.canSend ? (
            <>
              {gate.warning && (
                <div className="mb-1.5 text-[11px] text-gold/90">⚠ {gate.warning}</div>
              )}
              {error && (
                <div className="mb-1.5 text-[11px] text-danger">send failed: {error}</div>
              )}
              <div className="flex items-end gap-2">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  rows={2}
                  placeholder="message this session…  (⌘/Ctrl+Enter to send)"
                  className="max-h-40 min-h-[40px] flex-1 resize-y rounded-md border border-line bg-panel px-3 py-2 text-[13px] text-ink placeholder:text-ink-mute/60 focus:border-gold-dim/60 focus:outline-none"
                />
                <button
                  onClick={() => void send()}
                  disabled={sending || !text.trim()}
                  className="shrink-0 rounded-md border border-gold-dim/60 bg-gold/10 px-3.5 py-2 text-[13px] text-gold transition-colors hover:bg-gold/20 disabled:opacity-40"
                >
                  {sending ? "…" : "send"}
                </button>
              </div>
            </>
          ) : (
            <div className="py-1 text-center text-[12px] text-ink-mute">
              {gate.disabledReason}
            </div>
          )}
        </div>
      </footer>
    </div>
  );
}
