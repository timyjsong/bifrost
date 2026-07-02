import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type {
  ContentBlock,
  InteractionMessage,
  InteractionState,
  PermissionMode,
  SessionInfo,
  SlashCommand,
} from "../../../shared/types";
import { PERMISSION_MODES, PERMISSION_MODE_LABELS } from "../../../shared/types";
import { basename, tildify } from "../lib/format";
import { useSessionStream, usePaneState } from "../lib/useSessionStream";
import {
  promptGate,
  schedulePrompt,
  cancelPrompt,
  getDraft,
  saveDraft,
  reconcileDraft,
  uploadFiles,
  setMode,
  interrupt,
  answer,
  getSlashCommands,
  filterSlash,
  type UploadedFile,
} from "../lib/drive";
import { resolveKey, stopAction } from "../lib/keymap";
import {
  buildToolIndex,
  summarizeTool,
  visibleBlocks,
  type ToolIndex,
  type ToolResultView,
} from "../lib/toolView";
import { fetchSettings } from "../lib/settings";
import { Dot } from "./ui";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  isHorizontalBack,
  isCommitted,
  clampDrag,
  shouldComplete,
} from "../lib/gesture";

// Lazy — xterm.js is heavy and only needed when the raw view is opened, so it
// code-splits out of the main bundle (keeps the PWA's first load lean).
const RawTerminal = lazy(() =>
  import("./RawTerminal").then((m) => ({ default: m.RawTerminal })),
);

/** One tool/command call, collapsed to a single row by default; click to expand
 *  its full input + output. Errors start expanded (toolDefaultExpanded). This is
 *  behavior layered on Bifrost's own styling — not a reskin. */
function ToolCall({
  name,
  input,
  result,
}: {
  name: string;
  input: unknown;
  result?: ToolResultView;
}) {
  const summary = summarizeTool(name, input);
  const [expanded, setExpanded] = useState(false);
  // A failed call stays collapsed (like the rest) but the whole row turns red so
  // the failure is obvious at a glance without expanding.
  const err = result?.isError ?? false;
  return (
    <div className="font-mono text-[12px]">
      <button
        onClick={() => setExpanded((v) => !v)}
        className={`flex w-full items-baseline gap-1.5 text-left transition-colors ${
          err ? "text-danger/90 hover:text-danger" : "text-ink-mute hover:text-ink-dim"
        }`}
      >
        <span className={`shrink-0 ${err ? "text-danger/70" : "text-ink-mute/60"}`}>
          {expanded ? "▾" : "▸"}
        </span>
        <span className={`shrink-0 ${err ? "text-danger" : "text-auto"}`}>→ {name}</span>
        <span className={`min-w-0 truncate ${err ? "text-danger/80" : "text-ink-mute/80"}`}>
          {clip(summary, 160)}
        </span>
        {result && (
          <span className={`ml-auto shrink-0 ${err ? "text-danger" : "text-ink-mute/40"}`}>
            {err ? "✗" : "✓"}
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-1 space-y-1.5 border-l border-line-soft pl-3">
          {summary && (
            <div className="whitespace-pre-wrap break-words text-[11.5px] leading-snug text-ink-mute/80">
              {summary}
            </div>
          )}
          {result && (
            <div
              className={`whitespace-pre-wrap break-words text-[11.5px] leading-snug ${
                result.isError ? "text-danger/90" : "text-ink-mute/70"
              }`}
            >
              {clip(result.text.trim(), 2000) || "(no output)"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function PaperclipIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[18px]"
    >
      <path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.49 8.49a2 2 0 0 1-2.83-2.83l7.78-7.78" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[18px]"
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

/** Count real user PROMPTS (not tool_result lines) — the reconcile signal: a
 *  committed prompt adds exactly one, which clears the optimistic echo. */
function userPromptCount(st: InteractionState | null): number {
  if (!st) return 0;
  return st.messages.filter(
    (m) => m.role === "user" && !m.blocks.every((b) => b.kind === "tool_result"),
  ).length;
}

function Block({ b }: { b: Exclude<ContentBlock, { kind: "tool_use" }> }) {
  switch (b.kind) {
    case "thinking":
      return (
        <div className="whitespace-pre-wrap border-l-2 border-line-soft pl-3 text-[12.5px] italic leading-relaxed text-ink-mute/80">
          {b.text}
        </div>
      );
    case "text":
      return (
        <div className="chat-md text-[13.5px] leading-relaxed text-ink-dim">
          <Markdown remarkPlugins={[remarkGfm]}>{b.text}</Markdown>
        </div>
      );
    case "tool_result":
      return (
        <div
          className={`whitespace-pre-wrap break-words border-l border-line-soft pl-3 font-mono text-[11.5px] leading-snug ${
            b.isError ? "text-danger/90" : "text-ink-mute/70"
          }`}
        >
          {clip(b.text.trim(), 600) || "(no output)"}
        </div>
      );
  }
}

function renderBlock(tools: ToolIndex) {
  return (b: ContentBlock, i: number) =>
    b.kind === "tool_use" ? (
      <ToolCall key={i} name={b.name} input={b.input} result={tools.resultByUseId.get(b.id)} />
    ) : (
      <Block key={i} b={b} />
    );
}

function Message({ m, tools }: { m: InteractionMessage; tools: ToolIndex }) {
  const isUser = m.role === "user";
  const isToolResult = isUser && m.blocks.every((b) => b.kind === "tool_result");
  // A tool_result folded into its tool-call unit isn't rendered standalone; if
  // that empties the message (all blocks were consumed results), drop it.
  const blocks = visibleBlocks(m.blocks, tools.consumedForIds);
  if (blocks.length === 0) return null;
  const render = renderBlock(tools);

  if (isUser && !isToolResult) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-br-sm border border-gold-dim/40 bg-gold/[0.06] px-3.5 py-2 text-[13.5px] leading-relaxed text-ink">
          {blocks.map(render)}
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
      <div className="space-y-1.5">{blocks.map(render)}</div>
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
  const overlayRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ active: false, committed: false, startX: 0, startY: 0, dx: 0 });
  const [dragX, setDragX] = useState(0);
  const [snapping, setSnapping] = useState(false);
  const msgCount = state?.messages.length ?? 0;
  // Pair tool calls with their results so each renders as one collapsible unit.
  const toolIndex = useMemo(() => buildToolIndex(state?.messages ?? []), [state]);

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
  const fileRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [modeOptimistic, setModeOptimistic] = useState<PermissionMode | null>(null);
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
  // Current permission mode: the optimistic pick until the pane poll confirms it.
  const currentMode = modeOptimistic ?? pane?.mode ?? null;

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

  // iOS-style edge-swipe back: a drag starting at the left edge and moving
  // left→right follows the finger (the overlay slides across, revealing the
  // dashboard beneath); released past a fraction of the width it completes
  // (onClose), else it snaps back. Native non-passive listener so we can
  // preventDefault scrolling once the gesture commits to horizontal. Thresholds
  // are the pure, tested helpers in lib/gesture.
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        drag.current.active = false;
        return;
      }
      // Arm anywhere on the view — the rightward horizontal commit below is what
      // makes it a back-swipe; a vertical move stays a scroll. No edge needed
      // (the transcript can't scroll horizontally, so there's nothing to clash).
      drag.current = {
        active: true,
        committed: false,
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        dx: 0,
      };
      setSnapping(false);
    };
    const onMove = (e: TouchEvent) => {
      const d = drag.current;
      if (!d.active) return;
      const dx = e.touches[0].clientX - d.startX;
      const dy = e.touches[0].clientY - d.startY;
      if (!d.committed) {
        if (!isCommitted(dx, dy)) return;
        if (!isHorizontalBack(dx, dy)) {
          d.active = false; // vertical — let the transcript scroll
          return;
        }
        d.committed = true;
      }
      e.preventDefault();
      d.dx = clampDrag(dx, window.innerWidth);
      setDragX(d.dx);
    };
    const onEnd = () => {
      const d = drag.current;
      if (!d.active || !d.committed) {
        d.active = false;
        return;
      }
      d.active = false;
      setSnapping(true);
      if (shouldComplete(d.dx, window.innerWidth)) {
        setDragX(window.innerWidth);
        window.setTimeout(onClose, 220);
      } else {
        setDragX(0);
      }
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [onClose]);

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

  // Drop the optimistic mode once the pane reading agrees (or as a backstop).
  useEffect(() => {
    if (modeOptimistic !== null && pane?.mode === modeOptimistic) setModeOptimistic(null);
  }, [pane?.mode, modeOptimistic]);
  useEffect(() => {
    if (modeOptimistic === null) return;
    const t = setTimeout(() => setModeOptimistic(null), 4000);
    return () => clearTimeout(t);
  }, [modeOptimistic]);

  // A different session opened — drop any stale optimistic flip and grace window
  // (a send parked for the previous session still fires server-side; the UI just
  // stops tracking it here).
  useEffect(() => {
    setOptimistic(null);
    setGraceUntil(null);
    setPending(null);
    setAttachments([]);
    setModeOptimistic(null);
  }, [session.sessionId]);

  const submit = async () => {
    const t = text.trim();
    const atts = attachments;
    const paths = atts.map((a) => a.path);
    if (!gate.canSend || busy || sending || (!t && paths.length === 0)) return;
    // Inject the uploaded file paths into the prompt — the TUI can't take
    // binaries, so Claude reads them by path.
    const composed = paths.length ? `${paths.join("\n")}${t ? "\n" + t : ""}` : t;
    setSending(true);
    setError(null);
    pendingBase.current = userPromptCount(state);
    setPending(composed); // echo bubble
    skipSave.current = true; // server clears the draft when the send fires
    setText("");
    setAttachments([]);
    setGraceUntil(Date.now() + delayMs); // open the grace window (locks input)
    const res = await schedulePrompt(session.sessionId, composed);
    setSending(false);
    if (!res.ok) {
      // never parked — revert everything and surface the failure loud
      setPending(null);
      setGraceUntil(null);
      skipSave.current = true;
      setText(t);
      setAttachments(atts);
      setError(res.reason ?? "send failed");
    }
  };

  // Attach: upload picked files, then show them as chips; their paths are injected
  // into the prompt on send.
  const onPickFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // let the same file be re-picked later
    if (!files.length) return;
    setError(null);
    setUploading(true);
    const saved = await uploadFiles(session.sessionId, files);
    setUploading(false);
    if (saved.length) setAttachments((xs) => [...xs, ...saved]);
    else setError("upload failed");
  };

  // Permission mode: tap the pill to cycle (auto → accept edits → plan). The
  // server injects the Shift+Tab presses; optimistically show the next mode until
  // the pane poll confirms it.
  const cycleMode = async () => {
    const cur = currentMode ?? "auto";
    const next =
      PERMISSION_MODES[(PERMISSION_MODES.indexOf(cur) + 1) % PERMISSION_MODES.length];
    setModeOptimistic(next);
    const ok = await setMode(session.sessionId, next);
    if (!ok) setModeOptimistic(null); // failed — let the pane reading drive
  };

  // Stop does double duty: within the grace window it CANCELS the parked send
  // (undo — text returns); once the turn is running it INTERRUPTS (Esc).
  const stop = async () => {
    const action = stopAction(inGrace ? "pending" : working ? "working" : "idle");
    if (action === "cancel") {
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
    if (action !== "interrupt") return; // idle — nothing to stop
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
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[60] flex flex-col bg-bg"
      style={{
        transform: dragX ? `translateX(${dragX}px)` : undefined,
        transition: snapping ? "transform 0.22s ease-out" : undefined,
        boxShadow: dragX ? "-12px 0 28px rgba(0,0,0,0.45)" : undefined,
      }}
    >
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
      <div className="mx-auto w-full max-w-4xl flex-1 space-y-4 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-5 [touch-action:pan-y]">
        {state === null && (
          <div className="pt-10 text-center text-[12px] text-ink-mute">loading…</div>
        )}
        {state?.messages.length === 0 && pending === null && (
          <div className="pt-10 text-center text-[12px] text-ink-mute">
            no conversation yet
          </div>
        )}
        {state?.messages.map((m) => (
          <Message key={m.uuid} m={m} tools={toolIndex} />
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

      <footer className="chat-footer-safe border-t border-line-soft bg-bg/90 px-4 pt-3">
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
                <div className="rounded-2xl border border-line-soft bg-panel/50 transition-colors focus-within:border-gold-dim/60">
                  {attachments.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
                      {attachments.map((a) => (
                        <span
                          key={a.path}
                          className="inline-flex max-w-[200px] items-center gap-1 rounded-md border border-line-soft bg-bg/60 px-2 py-1 text-[11px] text-ink-dim"
                        >
                          <span className="shrink-0 text-ink-mute/70">
                            <PaperclipIcon />
                          </span>
                          <span className="truncate">{a.name}</span>
                          <button
                            onClick={() =>
                              setAttachments((xs) => xs.filter((x) => x.path !== a.path))
                            }
                            className="shrink-0 text-ink-mute transition-colors hover:text-danger"
                            aria-label={`remove ${a.name}`}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
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
                        ? "sending… ⌥⏎ to cancel"
                        : working
                          ? "running — compose your next message…"
                          : pendingRemote
                            ? "a send is in flight on another device…"
                            : "message this session…"
                    }
                    className="max-h-40 min-h-[44px] w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-[13px] text-ink placeholder:text-ink-mute/60 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <div className="flex items-center gap-1 px-2 pb-2">
                    <input
                      ref={fileRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => void onPickFiles(e)}
                    />
                    <button
                      onClick={() => fileRef.current?.click()}
                      disabled={inGrace || uploading}
                      title="attach files"
                      aria-label="attach files"
                      className="grid size-9 place-items-center rounded-full text-ink-mute transition-colors hover:bg-panel-raised hover:text-ink-dim disabled:opacity-40"
                    >
                      {uploading ? <span className="text-[12px]">…</span> : <PaperclipIcon />}
                    </button>
                    {currentMode && (
                      <button
                        onClick={() => void cycleMode()}
                        disabled={inGrace}
                        title="permission mode — tap to cycle (auto / accept edits / plan)"
                        className="rounded-full border border-line-soft px-2.5 py-1 text-[11px] text-ink-mute transition-colors hover:border-gold-dim/50 hover:text-ink-dim disabled:opacity-40"
                      >
                        {PERMISSION_MODE_LABELS[currentMode]}
                      </button>
                    )}
                    <div className="ml-auto">
                      {inGrace ? (
                        <button
                          onClick={() => void stop()}
                          title="cancel the send (alt+enter)"
                          aria-label="cancel send"
                          className="grid size-9 place-items-center rounded-full border border-danger/50 bg-danger/10 text-[12px] font-medium text-danger transition-colors hover:bg-danger/20"
                        >
                          {graceLeft}
                        </button>
                      ) : showStop ? (
                        <button
                          onClick={() => void stop()}
                          disabled={interrupting}
                          title="interrupt (alt+enter)"
                          aria-label="stop"
                          className="grid size-9 place-items-center rounded-full border border-danger/50 bg-danger/10 text-danger transition-colors hover:bg-danger/20 disabled:opacity-50"
                        >
                          {interrupting ? "…" : "■"}
                        </button>
                      ) : (
                        <button
                          onClick={() => void submit()}
                          disabled={
                            sending ||
                            uploading ||
                            pendingRemote ||
                            (!text.trim() && attachments.length === 0)
                          }
                          title={
                            pendingRemote
                              ? "a send is in flight on another device"
                              : "send (⌘/Ctrl+Enter)"
                          }
                          aria-label="send"
                          className="grid size-9 place-items-center rounded-full bg-gold text-bg transition-colors hover:bg-gold/90 disabled:bg-gold-dim/30 disabled:text-ink-mute"
                        >
                          {sending ? <span className="text-[12px]">…</span> : <ArrowUpIcon />}
                        </button>
                      )}
                    </div>
                  </div>
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
