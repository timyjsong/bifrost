import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type {
  ContentBlock,
  InteractionMessage,
  InteractionState,
  SessionInfo,
  SlashCommand,
} from "../../../shared/types";
import { basename, tildify } from "../lib/format";
import { useSessionStream, usePaneState } from "../lib/useSessionStream";
import {
  promptGate,
  schedulePrompt,
  cancelPrompt,
  getDraft,
  saveDraft,
  reconcileDraft,
  interrupt,
  answer,
  getSlashCommands,
  filterSlash,
} from "../lib/drive";
import { resolveKey } from "../lib/keymap";
import { fetchSettings } from "../lib/settings";
import { Dot } from "./ui";

// Lazy — xterm.js is heavy and only needed when the raw view is opened, so it
// code-splits out of the main bundle (keeps the PWA's first load lean).
const RawTerminal = lazy(() =>
  import("./RawTerminal").then((m) => ({ default: m.RawTerminal })),
);

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
  const pane = usePaneState(session.sessionId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const msgCount = state?.messages.length ?? 0;

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null); // optimistic echo
  const [interrupting, setInterrupting] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  // Send grace buffer: while a submitted prompt is parked (server-side), graceUntil
  // holds its fire timestamp; null once it has fired (or there's nothing parked).
  const [graceUntil, setGraceUntil] = useState<number | null>(null);
  const [delayMs, setDelayMs] = useState(3000); // grace duration, from settings
  const [, forceTick] = useState(0); // re-render the live countdown while in grace
  // Optimistic send↔stop: flips instantly on the user's click, then hands off to
  // the real pane "working" reading (ground truth, like the TUI). Because the pane
  // is accurate — not a laggy derived guess — it can't flip back.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const pendingBase = useRef(0); // user-prompt count at send time
  const skipSave = useRef(true); // don't persist the freshly-loaded/adopted draft back
  const lastSynced = useRef(""); // last draft value this device PUT or adopted (sync baseline)
  const textRef = useRef(text); // latest text, so the draft poll needn't reset on each keystroke
  textRef.current = text;
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [slashCmds, setSlashCmds] = useState<SlashCommand[]>([]);

  const gate = promptGate(session);
  const suggestions = filterSlash(text, slashCmds);
  // The send signal is SERVER-authoritative (the pane endpoint, polled by every
  // device): `working` = the main turn is in flight (control not yours yet);
  // `pane.pendingSend` = a send is parked server-side in its grace window. The
  // optimistic flip just hides this device's own poll latency until the pane
  // confirms. Send is disabled while busy; typing stays allowed throughout (only
  // this device's own grace window locks the box, so cancel can restore cleanly).
  const paneWorking = pane?.working ?? false;
  const working = optimistic ?? paneWorking; // main turn active (any device)
  const inGrace = graceUntil !== null; // my own parked send
  const pendingRemote = (pane?.pendingSend ?? false) && !inGrace; // another device's
  const busy = working || inGrace || pendingRemote; // send unavailable
  const showStop = !inGrace && working; // stop=interrupt only while a turn runs
  const graceLeft = graceUntil ? Math.max(0, Math.ceil((graceUntil - Date.now()) / 1000)) : 0;

  // Slash-command list for the suggester (disk-scanned server-side, fetched once).
  useEffect(() => {
    void getSlashCommands(session.sessionId).then(setSlashCmds);
  }, [session.sessionId]);

  // The configured grace period — the client mirrors the server's value so the
  // countdown and the real fire timer agree (both read the same stored setting).
  useEffect(() => {
    void fetchSettings().then((s) => setDelayMs(s.sendDelayMs));
  }, []);

  // When the grace window elapses, the server has injected the parked send — flip
  // the UI to "working". A backstop, since this drives input-lock state. Re-armed
  // whenever graceUntil changes (a fresh submit, or cleared on cancel).
  useEffect(() => {
    if (graceUntil === null) return;
    const ms = Math.max(0, graceUntil - Date.now());
    const fired = setTimeout(() => {
      setGraceUntil(null);
      setOptimistic(true); // it fired server-side → now running
    }, ms);
    const ticker = setInterval(() => forceTick((n) => n + 1), 250); // live countdown
    return () => {
      clearTimeout(fired);
      clearInterval(ticker);
    };
  }, [graceUntil]);

  const pickSlash = (name: string) => {
    setText(name + " "); // fill, don't send — args can follow
    taRef.current?.focus();
  };

  // Lock the dashboard's scroll behind the overlay so there's only one scrollbar
  // (the inner transcript) — not the page's persisting underneath it.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

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
        lastSynced.current = d; // baseline: what the server holds right now
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
    const t = text;
    draftTimer.current = setTimeout(() => {
      lastSynced.current = t; // our edit IS now the server's value (last-write-wins)
      void saveDraft(session.sessionId, t);
    }, 500);
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [text, session.sessionId]);

  // Live cross-device sync (receive side): poll the server draft and ADOPT edits
  // made on another device. reconcileDraft only adopts when the server value
  // differs from BOTH our baseline and the box — so it never clobbers keystrokes
  // we haven't saved yet. Latency-tolerant (1s); the box being disabled mid-grace
  // doesn't matter, we only read here.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const remote = await getDraft(session.sessionId);
      if (!alive) return;
      const r = reconcileDraft({
        local: textRef.current,
        lastSynced: lastSynced.current,
        remote,
      });
      lastSynced.current = r.baseline;
      if (r.adopt) {
        skipSave.current = true; // came from the server — don't echo it back
        setText(r.value);
      }
    };
    const t = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [session.sessionId]);

  // Reconcile the optimistic echo: once the transcript shows the new prompt
  // (the user-prompt count grew past the send-time base), drop the echo so the
  // message isn't rendered twice (AC3.4).
  useEffect(() => {
    if (pending !== null && userPromptCount(state) > pendingBase.current) {
      setPending(null);
    }
  }, [state, pending]);

  // Hand off to the pane once it agrees with the optimistic flip — no flicker,
  // because the pane is accurate (a "not working" reading after a stop is real,
  // not stale). A backstop clears it if the pane never confirms (an instant turn).
  useEffect(() => {
    if (optimistic !== null && optimistic === paneWorking) setOptimistic(null);
  }, [optimistic, paneWorking]);
  useEffect(() => {
    if (optimistic === null) return;
    const t = setTimeout(() => setOptimistic(null), 4000);
    return () => clearTimeout(t);
  }, [optimistic]);

  // A different session opened — drop any stale optimistic flip and grace window
  // (a send parked for the previous session still fires server-side; the UI just
  // stops tracking it here).
  useEffect(() => {
    setOptimistic(null);
    setGraceUntil(null);
    setPending(null);
  }, [session.sessionId]);

  const submit = async () => {
    const t = text.trim();
    if (!gate.canSend || busy || sending || !t) return;
    setSending(true);
    setError(null);
    pendingBase.current = userPromptCount(state);
    setPending(t); // echo bubble
    skipSave.current = true; // server clears the draft when the send fires
    setText("");
    setGraceUntil(Date.now() + delayMs); // open the grace window (locks input)
    const res = await schedulePrompt(session.sessionId, t);
    setSending(false);
    if (!res.ok) {
      // never parked — revert everything and surface the failure loud
      setPending(null);
      setGraceUntil(null);
      skipSave.current = true;
      setText(t);
      setError(res.reason ?? "send failed");
    }
  };

  // Stop does double duty: within the grace window it CANCELS the parked send
  // (undo — text returns); once the turn is running it INTERRUPTS (Esc).
  const stop = async () => {
    if (inGrace) {
      const parked = pending;
      setGraceUntil(null);
      const res = await cancelPrompt(session.sessionId);
      if (res.cancelled) {
        setPending(null);
        if (parked) {
          skipSave.current = true; // still the server draft — don't re-save
          setText(parked);
        }
      } else {
        setOptimistic(true); // raced past cancel — it sent; let it run
      }
      return;
    }
    if (!working) return; // nothing running to interrupt (idle / another device's send)
    if (interrupting) return;
    setInterrupting(true);
    setOptimistic(false); // flip toward send immediately
    setError(null);
    const res = await interrupt(session.sessionId);
    setInterrupting(false);
    if (!res.ok) {
      setOptimistic(null); // failed — let the pane drive
      setError(res.reason ?? "interrupt failed");
    }
  };

  const answerMenu = async (key: string) => {
    setError(null);
    const res = await answer(session.sessionId, key);
    if (!res.ok) setError(res.reason ?? "answer failed");
  };

  // The keymap lives at the VIEW level, not on the textarea — so a chord still
  // works while input is locked during the grace window (a disabled textarea gets
  // no key events). A ref carries the latest handlers so the listener stays stable
  // (mounted once) yet never reads stale state. enter→newline is a no-op here
  // (we don't preventDefault), so the textarea's native newline still happens.
  const keymap = useRef({ submit, stop, onClose, rawOpen });
  keymap.current = { submit, stop, onClose, rawOpen };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = resolveKey(e);
      if (!action || action === "newline") return;
      if (action === "close") {
        e.preventDefault();
        keymap.current.onClose();
        return;
      }
      // submit/stop only act on the chat compose flow, not the raw mirror.
      if (keymap.current.rawOpen) return;
      e.preventDefault();
      if (action === "submit") void keymap.current.submit();
      else if (action === "stop") void keymap.current.stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
        <div className="ml-auto flex shrink-0 items-center gap-2.5">
          <button
            onClick={() => setRawOpen((v) => !v)}
            className="rounded-md border border-line px-2 py-1 text-[11px] text-ink-dim transition-colors hover:bg-panel-raised hover:text-ink"
            title={rawOpen ? "back to the rendered view" : "raw terminal mirror"}
          >
            {rawOpen ? "chat" : "raw"}
          </button>
          <span className="flex items-center gap-1.5 text-[11px] text-ink-mute">
            <Dot tone={connected ? "gold" : "danger"} pulse={connected} />
            {connected ? "live" : "reconnecting…"}
          </span>
        </div>
      </header>

      {rawOpen ? (
        <div className="flex-1 overflow-hidden bg-[#0a0a0a] p-2">
          <Suspense
            fallback={
              <div className="p-4 text-[12px] text-ink-mute">loading terminal…</div>
            }
          >
            <RawTerminal sessionId={session.sessionId} />
          </Suspense>
        </div>
      ) : (
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
              <span className="ml-2 align-middle text-[10px] text-ink-mute">
                {inGrace ? `sending in ${graceLeft}s · ⌥⏎ to cancel` : "sending…"}
              </span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      )}

      <footer className="border-t border-line-soft bg-bg/90 px-4 py-3">
        <div className="mx-auto w-full max-w-4xl">
          {pane?.menu && (
            <div className="mb-3 rounded-md border border-danger/40 bg-danger/[0.06] p-3">
              <div className="mb-2 text-[12.5px] text-ink">{pane.menu.prompt}</div>
              <div className="flex flex-wrap gap-2">
                {pane.menu.options.map((o) => (
                  <button
                    key={o.key}
                    onClick={() => void answerMenu(o.key)}
                    className="rounded-md border border-line bg-panel-raised px-3 py-1.5 text-[12.5px] text-ink-dim transition-colors hover:border-gold-dim/60 hover:text-gold"
                  >
                    <span className="font-mono text-ink-mute">{o.key}</span> {o.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {!pane?.menu && session.state === "approval" && pane?.drivable && (
            <div className="mb-3 rounded-md border border-gold-dim/50 bg-gold/[0.05] p-3">
              <div className="mb-1.5 text-[11.5px] text-gold">
                ⚠ a permission prompt looks active, but Bifrost couldn't read the
                menu — answer in the raw terminal, or type your choice below.
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] leading-snug text-ink-mute">
                {pane.raw}
              </pre>
            </div>
          )}
          {gate.canSend ? (
            <>
              {gate.warning && (
                <div className="mb-1.5 text-[11px] text-gold/90">⚠ {gate.warning}</div>
              )}
              {error && (
                <div className="mb-1.5 text-[11px] text-danger">send failed: {error}</div>
              )}
              <div className="relative">
                {suggestions.length > 0 && (
                  <div className="absolute bottom-full mb-1 max-h-56 w-full overflow-auto rounded-md border border-line bg-panel-raised shadow-lg">
                    {suggestions.map((c) => (
                      <button
                        key={c.name}
                        onMouseDown={(e) => {
                          e.preventDefault(); // keep textarea focus
                          pickSlash(c.name);
                        }}
                        className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[12.5px] text-ink-dim transition-colors hover:bg-panel hover:text-gold"
                      >
                        <span className="font-mono">{c.name}</span>
                        <span className="text-[10px] text-ink-mute">{c.source}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <textarea
                    ref={taRef}
                    value={text}
                    // Only MY grace window locks the box (so cancel can restore the
                    // sent text). While a turn runs you can keep composing — send is
                    // what's gated, not typing.
                    disabled={inGrace}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      // Only the slash-accept lives here; submit/stop/close are
                      // handled view-wide by the keymap effect (works even when
                      // this textarea is disabled). enter→newline falls through.
                      if (e.key === "Tab" && suggestions.length > 0) {
                        e.preventDefault();
                        pickSlash(suggestions[0].name); // accept the top suggestion
                      }
                    }}
                    rows={2}
                    placeholder={
                      inGrace
                        ? "sending… ⌥⏎ (alt+enter) to cancel"
                        : working
                          ? "running — compose your next message · ⌥⏎ to interrupt"
                          : pendingRemote
                            ? "a send is in flight on another device…"
                            : "message this session…  (⌘/Ctrl+Enter to send · enter for newline · / for commands)"
                    }
                    className="max-h-40 min-h-[40px] flex-1 resize-y rounded-md border border-line bg-panel px-3 py-2 text-[13px] text-ink placeholder:text-ink-mute/60 focus:border-gold-dim/60 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  {inGrace ? (
                    <button
                      onClick={() => void stop()}
                      className="shrink-0 rounded-md border border-danger/50 bg-danger/10 px-3.5 py-2 text-[13px] font-medium text-danger transition-colors hover:bg-danger/20"
                      title="cancel the send (alt+enter)"
                    >
                      cancel · {graceLeft}s
                    </button>
                  ) : showStop ? (
                    <button
                      onClick={() => void stop()}
                      disabled={interrupting}
                      className="shrink-0 rounded-md border border-danger/50 bg-danger/10 px-3.5 py-2 text-[13px] font-medium text-danger transition-colors hover:bg-danger/20 disabled:opacity-50"
                      title="interrupt (alt+enter)"
                    >
                      {interrupting ? "…" : "■ stop"}
                    </button>
                  ) : (
                    <button
                      onClick={() => void submit()}
                      disabled={sending || pendingRemote || !text.trim()}
                      className="shrink-0 rounded-md border border-gold-dim/60 bg-gold/10 px-3.5 py-2 text-[13px] text-gold transition-colors hover:bg-gold/20 disabled:opacity-40"
                      title={pendingRemote ? "a send is in flight on another device" : undefined}
                    >
                      {sending ? "…" : "send"}
                    </button>
                  )}
                </div>
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
