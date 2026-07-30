import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type {
  InteractionState,
  PermissionMode,
  SessionInfo,
  SlashCommand,
} from "../../../shared/types";
import { PERMISSION_MODES, PERMISSION_MODE_LABELS } from "../../../shared/types";
import { basename, tildify, fmtKb } from "../lib/format";
import { groupChildren } from "../lib/cardModel";
import { useSessionStream, usePaneState } from "../lib/useSessionStream";
import { Message } from "./Transcript";
import {
  promptGate,
  schedulePrompt,
  sendOutcome,
  cancelPrompt,
  getDraft,
  saveDraft,
  reconcileDraft,
  sendFailureMessage,
  uploadFiles,
  setMode,
  interrupt,
  answer,
  getSlashCommands,
  filterSlash,
  rewindOpen,
  rewindSelect,
  rewindCancel,
  modelOpen,
  modelSelect,
  modelCancel,
  effortOpen,
  effortSelect,
  effortCancel,
  interceptComposer,
  menuFailureMessage,
  getSessionDiff,
  diffLineKind,
  type ModelOption,
  type RewindCheckpoint,
  type SessionDiffState,
  type UploadedFile,
} from "../lib/drive";
import { resolveKey, stopAction } from "../lib/keymap";
import { slashTag } from "../lib/slashPanels";
import { splitDiffByFile, type FileDiff } from "../lib/diffModel";
import { restartSession, type RestartMode } from "../lib/recycle";
import { buildToolIndex } from "../lib/toolView";
import { windowMessages } from "../lib/messageWindow";
import { fetchSettings } from "../lib/settings";
import { startGuardedPoll } from "../lib/poll";
import { Dot, PaperclipIcon } from "./ui";
import {
  isHorizontalBack,
  isCommitted,
  clampDrag,
  shouldComplete,
  isNearBottom,
} from "../lib/gesture";

// Tail-render cap: how many trailing messages the drive transcript mounts
// before offering "show earlier". Recent turns are what you drive against.
const MSG_WINDOW = 120;

// Lazy — xterm.js is heavy and only needed when the raw view is opened, so it
// code-splits out of the main bundle (keeps the PWA's first load lean).
const RawTerminal = lazy(() =>
  import("./RawTerminal").then((m) => ({ default: m.RawTerminal })),
);

const DIFF_STATUS_LABEL: Record<FileDiff["status"], string> = {
  modified: "",
  added: "new",
  deleted: "deleted",
  renamed: "renamed",
  binary: "binary",
};

// One file's diff in the review panel: a header row (path · status · +N −M)
// that toggles the hunk body, so a multi-file change reads as a file list you
// expand, not one flat wall. Own collapse state — collapsed once reviewed.
function DiffFileSection({ file }: { file: FileDiff }) {
  const [open, setOpen] = useState(true);
  const badge = DIFF_STATUS_LABEL[file.status];
  return (
    <div className="rounded-md border border-line-soft bg-panel/30">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <span className="text-[10px] text-ink-mute">{open ? "▾" : "▸"}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-dim">
          {file.label}
        </span>
        {badge && (
          <span className="shrink-0 rounded-sm border border-line-soft px-1 text-[10px] text-ink-mute">
            {badge}
          </span>
        )}
        <span className="shrink-0 font-mono text-[11px]">
          <span className="text-tmux">+{file.added}</span>{" "}
          <span className="text-danger">−{file.removed}</span>
        </span>
      </button>
      {open && (
        <pre className="overflow-x-auto whitespace-pre border-t border-line-soft px-2.5 py-1.5 font-mono text-[11px] leading-snug">
          {file.lines.map((l, i) => {
            const kind = diffLineKind(l);
            const cls =
              kind === "add"
                ? "text-tmux"
                : kind === "del"
                  ? "text-danger"
                  : kind === "hunk"
                    ? "text-gold/80"
                    : kind === "meta"
                      ? "text-ink-mute"
                      : "text-ink-dim";
            return (
              <div key={i} className={cls}>
                {l || " "}
              </div>
            );
          })}
        </pre>
      )}
    </div>
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

/**
 * The live single-session drive view (Build 1). M2 rendered it read-only; M3 adds
 * the prompt box: local-echo input, cross-device draft sync, commit-to-send with an
 * optimistic echo that reconciles against the transcript, and warn-and-allow gating.
 */
export function DriveView({
  session,
  onClose,
  onRestarted,
  now,
}: {
  session: SessionInfo;
  onClose: () => void;
  onRestarted: (sessionId: string) => void;
  /** App's 1s clock. Passed in rather than read here so the render stays pure —
   *  the grace countdown is a function of props, not of when React happened to
   *  re-run this component. */
  now: number;
}) {
  const { state, connected } = useSessionStream(session.sessionId);
  const pane = usePaneState(session.sessionId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ active: false, committed: false, startX: 0, startY: 0, dx: 0 });
  const [dragX, setDragX] = useState(0);
  const [snapping, setSnapping] = useState(false);
  const msgCount = state?.messages.length ?? 0;
  // Pair tool calls with their results so each renders as one collapsible unit.
  const toolIndex = useMemo(() => buildToolIndex(state?.messages ?? []), [state]);

  // Render only the tail by default; a big transcript otherwise mounts every
  // message (and re-mounts on each redial). toolIndex above stays built from
  // ALL messages, so tool_use↔tool_result correlation is intact when expanded.
  const [expanded, setExpanded] = useState(false);
  const { visible: visibleMessages, hiddenCount } = useMemo(
    () => windowMessages(state?.messages ?? [], MSG_WINDOW, expanded),
    [state, expanded],
  );

  const [text, setText] = useState("");
  const [composerHint, setComposerHint] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendNotice, setSendNotice] = useState<string | null>(null); // non-failure send advisory
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
  const failAck = useRef(0); // last fire-time send failure this device surfaced
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
  // Restart (story 2-7): the confirm strip is the explicit confirm-before-kill
  // the server requires (AC7.1) — nothing is killed until a mode is chosen here.
  const [restartOpen, setRestartOpen] = useState(false);
  const [restarting, setRestarting] = useState<RestartMode | null>(null);
  const [restartError, setRestartError] = useState<string | null>(null);
  // Rewind (checkpoints): the strip lists stage-1 checkpoints; picking one
  // hands off to the TUI's numbered confirm, which the NORMAL pane-menu UI
  // renders and answers (no bespoke stage-2 surface).
  // Session diff (review spine): the badge shows the cumulative uncommitted
  // stat; refreshed on open and every time a turn completes (working→idle
  // edge — the moment new output has landed).
  const [diffState, setDiffState] = useState<SessionDiffState>({ git: false });
  const [diffOpen, setDiffOpen] = useState(false);
  const prevWorking = useRef(false);
  useEffect(() => {
    void getSessionDiff(session.sessionId).then(setDiffState);
  }, [session.sessionId]);
  const paneWorkingNow = pane?.working ?? false;
  useEffect(() => {
    if (prevWorking.current && !paneWorkingNow) {
      void getSessionDiff(session.sessionId).then(setDiffState);
    }
    prevWorking.current = paneWorkingNow;
  }, [paneWorkingNow, session.sessionId]);
  // Split the flat unified diff into per-file sections for the review panel.
  const diffFiles = useMemo(
    () => (diffState.git ? splitDiffByFile(diffState.diff) : []),
    [diffState],
  );

  const [rewindStrip, setRewindStrip] = useState<RewindCheckpoint[] | null>(null);
  const [rewindBusy, setRewindBusy] = useState(false);
  const [rewindError, setRewindError] = useState<string | null>(null);

  const openRewind = async () => {
    if (rewindBusy) return;
    setRewindBusy(true);
    setRewindError(null);
    const r = await rewindOpen(session.sessionId);
    if (r.ok === true) setRewindStrip(r.checkpoints);
    else setRewindError(menuFailureMessage(r.reason, "rewind menu"));
    setRewindBusy(false);
  };

  const pickRewind = async (index: number) => {
    if (rewindBusy) return;
    const cp = rewindStrip?.[index];
    if (!cp) return;
    setRewindBusy(true);
    // Commit by identity (label + detail), not index — the picker re-opens fresh
    // on the server and the checkpoint list may have grown since the peek.
    const res = await rewindSelect(session.sessionId, { label: cp.label, detail: cp.detail });
    if (res.ok) {
      setRewindStrip(null); // the numbered confirm arrives via the pane poll
    } else {
      setRewindError(
        res.reason === "gone"
          ? "that checkpoint is no longer available — reopen rewind and pick again"
          : menuFailureMessage(res.reason ?? "", "rewind menu"),
      );
    }
    setRewindBusy(false);
  };

  const closeRewind = async () => {
    setRewindStrip(null);
    setRewindError(null);
    await rewindCancel(session.sessionId);
  };

  // Model switching — the TUI's /model picker driven server-side, always
  // session-scoped ("s", never the account-default Enter). Options come from
  // the live picker, so the list is whatever this Claude Code version offers.
  const [modelStrip, setModelStrip] = useState<ModelOption[] | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  const openModel = async () => {
    if (modelBusy) return;
    setModelBusy(true);
    setModelError(null);
    const r = await modelOpen(session.sessionId);
    if (r.ok === true) setModelStrip(r.options);
    else setModelError(menuFailureMessage(r.reason, "model menu"));
    setModelBusy(false);
  };

  const pickModel = async (index: number) => {
    if (modelBusy) return;
    const opt = modelStrip?.[index];
    if (!opt) return;
    setModelBusy(true);
    const res = await modelSelect(session.sessionId, opt.label); // by label, not index
    if (res.ok) setModelStrip(null);
    else setModelError(menuFailureMessage(res.reason ?? "", "model menu"));
    setModelBusy(false);
  };

  const closeModel = async () => {
    setModelStrip(null);
    setModelError(null);
    await modelCancel(session.sessionId);
  };

  // Effort — the TUI's /effort slider, driven server-side; session-scoped
  // (verified: the account settings file is untouched by the confirm).
  const [effortStrip, setEffortStrip] = useState<{ options: string[]; currentIndex: number } | null>(null);
  const [effortBusy, setEffortBusy] = useState(false);
  const [effortError, setEffortError] = useState<string | null>(null);

  const openEffort = async () => {
    if (effortBusy) return;
    setEffortBusy(true);
    setEffortError(null);
    const r = await effortOpen(session.sessionId);
    if (r.ok === true) setEffortStrip({ options: r.options, currentIndex: r.currentIndex });
    else
      setEffortError(
        r.reason === "effort-unsupported"
          ? "effort isn't available for this session's model"
          : menuFailureMessage(r.reason, "effort slider"),
      );
    setEffortBusy(false);
  };

  const pickEffort = async (index: number) => {
    if (effortBusy) return;
    const value = effortStrip?.options[index];
    if (value === undefined) return;
    setEffortBusy(true);
    const res = await effortSelect(session.sessionId, value); // by label, not index
    if (res.ok) setEffortStrip(null);
    else setEffortError(menuFailureMessage(res.reason ?? "", "effort slider"));
    setEffortBusy(false);
  };

  const closeEffort = async () => {
    setEffortStrip(null);
    setEffortError(null);
    await effortCancel(session.sessionId);
  };

  const doRestart = async (mode: RestartMode) => {
    if (restarting) return;
    setRestarting(mode);
    setRestartError(null);
    const outcome = await restartSession(session.sessionId, mode);
    if (outcome.kind === "open-drive") {
      setRestartOpen(false);
      onRestarted(outcome.sessionId);
    } else {
      setRestartError(outcome.message);
    }
    setRestarting(null);
  };

  const gate = promptGate(session);
  // Drivable = injectable (tmux-resident). A foreign/non-tmux session is
  // VIEW-ONLY per GOAL — the drive-action controls (rewind/restart, and the
  // model/effort pills already inside the composer's canSend block) must not
  // render, or they'd fail with a misleading error. Read-only views (transcript,
  // diff, raw pane) stay.
  const drivable = gate.canSend;
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
  // Background work (fanned-out subagents, bg shells) running under this
  // session. The dashboard card shows it; the drive view didn't, so a soft-idle
  // session with a live subagent read as plain idle while driving. Reuses the
  // dashboard's tested grouping so identical fan-outs fold into one ×N line.
  const bgGroups = groupChildren(session.children ?? []);
  const graceLeft = graceUntil ? Math.max(0, Math.ceil((graceUntil - now) / 1000)) : 0;
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

  // Stick to the latest as the conversation grows — but ONLY when the reader is
  // already near the bottom, so scrolling up to read scrollback mid-turn isn't
  // yanked back down on every append (the big-transcript jank).
  useEffect(() => {
    const sc = scrollRef.current;
    if (sc && !isNearBottom(sc.scrollTop, sc.scrollHeight, sc.clientHeight)) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [msgCount, pending]);

  // Load the cross-device draft when the session opens.
  useEffect(() => {
    let alive = true;
    void getDraft(session.sessionId).then((d) => {
      if (alive) {
        skipSave.current = true;
        lastSynced.current = d.text; // baseline: what the server holds right now
        setText(d.text);
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
      // Advance the sync baseline ONLY if the server accepted the PUT — a failed
      // save must not move `lastSynced` ahead of the server's real value, or the
      // receive-poll would adopt the stale server draft over newer local text
      // (audit M1). On failure the baseline stays put; next edit retries.
      void saveDraft(session.sessionId, t).then((ok) => {
        if (ok) lastSynced.current = t;
      });
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
    // Guarded poll (was setInterval): never stacks a second draft GET while one
    // is in flight on a slow link.
    return startGuardedPoll(async () => {
      const { text: remote, sendFailure: fail } = await getDraft(session.sessionId);
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
      // A parked send failed at fire time (recorded server-side): drop the ghost
      // echo (nothing landed), surface the loud strip, and restore the text —
      // the server never cleared the draft, so it's still there to restore.
      if (fail && fail.at > failAck.current) {
        failAck.current = fail.at;
        setPending(null);
        setGraceUntil(null);
        setOptimistic(null);
        setError(sendFailureMessage(fail.reason));
        if (!textRef.current.trim() && remote.trim()) {
          skipSave.current = true; // restoring the server draft, not a new edit
          lastSynced.current = remote;
          setText(remote);
        }
      }
    }, 1000);
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

  // A different session opened — nothing to reset here. App renders
  // <DriveView key={session.sessionId}>, so switching sessions REMOUNTS this
  // component and every optimistic flip, grace window, pending send and
  // attachment list starts fresh on its own. The effect that used to clear them
  // by hand was keyed on the same sessionId, so it could only ever fire on
  // mount, against values already at their initial state.
  // If that key at the call site is ever removed, the reset has to come back.

  const submit = async () => {
    const t = text.trim();
    const atts = attachments;
    const paths = atts.map((a) => a.path);
    if (!gate.canSend || busy || sending || (!t && paths.length === 0)) return;
    const hint = interceptComposer(t);
    if (hint) {
      setComposerHint(hint);
      return;
    }
    // Inject the uploaded file paths into the prompt — the TUI can't take
    // binaries, so Claude reads them by path.
    const composed = paths.length ? `${paths.join("\n")}${t ? "\n" + t : ""}` : t;
    setSending(true);
    setError(null);
    setSendNotice(null);
    pendingBase.current = userPromptCount(state);
    setPending(composed); // echo bubble
    skipSave.current = true; // server clears the draft when the send fires
    setText("");
    setAttachments([]);
    setGraceUntil(Date.now() + delayMs); // open the grace window (locks input)
    const res = await schedulePrompt(session.sessionId, composed);
    setSending(false);
    const outcome = sendOutcome(res);
    if (outcome === "rejected") {
      // the server refused it — it definitely never parked, so revert
      // everything and surface the failure loud.
      setPending(null);
      setGraceUntil(null);
      skipSave.current = true;
      setText(t);
      setAttachments(atts);
      setError(res.reason ?? "send failed");
    } else if (outcome === "indeterminate") {
      // the POST threw after it may have reached the server (a dropped mobile
      // link), which would park and fire. Drop this device's optimistic
      // grace/echo — server truth (pane.pendingSend / the transcript) drives now
      // — but do NOT restore the text: a blind resend would double-send. It's a
      // warning, not a failure (it may well have gone through), so it takes the
      // gold advisory strip, never the red "send failed" one.
      setPending(null);
      setGraceUntil(null);
      setSendNotice("couldn't confirm the send — check the transcript before resending");
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
          {diffState.git && (diffState.stat.insertions > 0 || diffState.stat.deletions > 0) && (
            <button
              onClick={() => setDiffOpen((v) => !v)}
              className={`rounded-md border px-2 py-1 font-mono text-[11px] tabular-nums transition-colors ${
                diffOpen
                  ? "border-gold-dim/60 text-gold"
                  : "border-line text-ink-dim hover:bg-panel-raised hover:text-ink"
              }`}
              title="review the session's uncommitted changes"
            >
              <span className="text-tmux">+{diffState.stat.insertions}</span>{" "}
              <span className="text-danger">−{diffState.stat.deletions}</span>
            </button>
          )}
          {drivable && (
            <button
              onClick={() => (rewindStrip || rewindError ? void closeRewind() : void openRewind())}
              disabled={rewindBusy}
              className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                rewindStrip
                  ? "border-gold-dim/60 text-gold"
                  : "border-line text-ink-dim hover:bg-panel-raised hover:text-ink"
              }`}
              title="rewind — restore the conversation to an earlier checkpoint"
            >
              {rewindBusy ? "…" : "rewind"}
            </button>
          )}
          {drivable && (
            <button
              onClick={() => {
                setRestartOpen((v) => !v);
                setRestartError(null);
              }}
              className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                restartOpen
                  ? "border-gold-dim/60 text-gold"
                  : "border-line text-ink-dim hover:bg-panel-raised hover:text-ink"
              }`}
              title="restart this session (resume the conversation or start fresh)"
            >
              restart
            </button>
          )}
          <button
            onClick={() => setRawOpen((v) => !v)}
            className="rounded-md border border-line px-2 py-1 text-[11px] text-ink-dim transition-colors hover:bg-panel-raised hover:text-ink"
            title={rawOpen ? "back to the rendered view" : "raw terminal mirror"}
          >
            {rawOpen ? "chat" : "raw"}
          </button>
          {!drivable && (
            <span
              className="rounded-md border border-line-soft px-2 py-1 text-[11px] text-ink-mute"
              title="this session isn't tmux-resident — Bifrost can view it but not drive it"
            >
              view-only
            </span>
          )}
          <span className="flex items-center gap-1.5 text-[11px] text-ink-mute">
            <Dot tone={connected ? "gold" : "danger"} pulse={connected} />
            {connected ? "live" : "reconnecting…"}
          </span>
        </div>
      </header>
      {bgGroups.length > 0 && (
        <div className="flex flex-col gap-1 border-b border-line-soft bg-panel/50 px-4 py-2">
          <div className="flex items-center gap-1.5 text-[11px] text-ink-mute">
            <Dot tone="auto" pulse />
            {session.children!.length} background{" "}
            {session.children!.length === 1 ? "task" : "tasks"} running
          </div>
          <ul className="flex flex-col gap-0.5 border-l border-line-soft pl-3">
            {bgGroups.map(({ c, n, rssKb, cpu }) => (
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
                  {fmtKb(rssKb)}
                  {cpu >= 0.5 ? ` · ${cpu < 10 ? cpu.toFixed(1) : cpu.toFixed(0)}% box` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {diffOpen && diffState.git && (
        <div className="max-h-[45dvh] overflow-auto border-b border-line-soft bg-panel/40 px-4 py-2">
          <div className="mb-1.5 text-[11px] text-ink-mute">
            {diffState.stat.files} file{diffState.stat.files === 1 ? "" : "s"} changed ·
            working tree vs HEAD{diffState.truncated ? " · truncated" : ""}
          </div>
          <div className="flex flex-col gap-1">
            {diffFiles.map((f) => (
              <DiffFileSection key={f.path} file={f} />
            ))}
          </div>
        </div>
      )}
      {(rewindStrip || rewindError) && (
        <div className="flex flex-col gap-1.5 border-b border-line-soft bg-panel/60 px-4 py-2 text-[12px]">
          {rewindError ? (
            <span className="text-danger">{rewindError}</span>
          ) : (
            <>
              <span className="text-ink-dim">
                Restore the conversation to the point before…
              </span>
              {rewindStrip!.map((c, i) => (
                <button
                  key={i}
                  onClick={() => void pickRewind(i)}
                  disabled={rewindBusy}
                  className="flex min-w-0 items-baseline gap-2 rounded-md border border-line px-2.5 py-1 text-left transition-colors hover:border-gold-dim/60 hover:text-gold"
                >
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{c.label}</span>
                  <span className="shrink-0 text-[11px] text-ink-mute">{c.detail}</span>
                </button>
              ))}
            </>
          )}
          <button
            onClick={() => void closeRewind()}
            className="self-start rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-mute transition-colors hover:text-ink-dim"
          >
            cancel
          </button>
        </div>
      )}
      {(modelStrip || modelError) && (
        <div className="flex flex-col gap-1.5 border-b border-line-soft bg-panel/60 px-4 py-2 text-[12px]">
          {modelError ? (
            <span className="text-danger">{modelError}</span>
          ) : (
            <>
              <span className="text-ink-dim">
                Switch this session&rsquo;s model — your account default is untouched.
              </span>
              {modelStrip!.map((o, i) => (
                <button
                  key={i}
                  onClick={() => void pickModel(i)}
                  disabled={modelBusy || o.current}
                  className={`flex min-w-0 items-baseline gap-2 rounded-md border px-2.5 py-1 text-left transition-colors ${
                    o.current
                      ? "border-gold-dim/60 text-gold"
                      : "border-line hover:border-gold-dim/60 hover:text-gold"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                    {o.label}
                    {o.current ? " ✓ current" : ""}
                  </span>
                  <span className="shrink-0 text-[11px] text-ink-mute">{o.detail}</span>
                </button>
              ))}
            </>
          )}
          <button
            onClick={() => void closeModel()}
            className="self-start rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-mute transition-colors hover:text-ink-dim"
          >
            cancel
          </button>
        </div>
      )}
      {(effortStrip || effortError) && (
        <div className="flex flex-col gap-1.5 border-b border-line-soft bg-panel/60 px-4 py-2 text-[12px]">
          {effortError ? (
            <span className="text-danger">{effortError}</span>
          ) : (
            <>
              <span className="text-ink-dim">
                Reasoning effort for this session.
              </span>
              <div className="flex flex-wrap gap-1.5">
                {effortStrip!.options.map((o, i) => (
                  <button
                    key={o}
                    onClick={() => void pickEffort(i)}
                    disabled={effortBusy || i === effortStrip!.currentIndex}
                    className={`rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
                      i === effortStrip!.currentIndex
                        ? "border-gold-dim/60 text-gold"
                        : "border-line text-ink hover:border-gold-dim/60 hover:text-gold"
                    }`}
                  >
                    {o}
                    {i === effortStrip!.currentIndex ? " ✓" : ""}
                  </button>
                ))}
              </div>
            </>
          )}
          <button
            onClick={() => void closeEffort()}
            className="self-start rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-mute transition-colors hover:text-ink-dim"
          >
            cancel
          </button>
        </div>
      )}
      {restartOpen && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line-soft bg-panel/60 px-4 py-2 text-[12px]">
          <span className="text-ink-dim">
            Kills the running process — anything mid-turn is lost.
          </span>
          <button
            onClick={() => doRestart("resume")}
            disabled={restarting !== null}
            className="rounded-md border border-gold-dim/60 px-2.5 py-1 text-[11px] text-gold transition-colors hover:bg-gold-dim/10 disabled:border-line disabled:text-ink-mute"
          >
            {restarting === "resume" ? "restarting…" : "continue conversation"}
          </button>
          <button
            onClick={() => doRestart("fresh")}
            disabled={restarting !== null}
            className="rounded-md border border-gold-dim/60 px-2.5 py-1 text-[11px] text-gold transition-colors hover:bg-gold-dim/10 disabled:border-line disabled:text-ink-mute"
          >
            {restarting === "fresh" ? "restarting…" : "fresh session"}
          </button>
          <button
            onClick={() => setRestartOpen(false)}
            disabled={restarting !== null}
            className="rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-mute transition-colors hover:text-ink-dim"
          >
            cancel
          </button>
          {restartError && <span className="text-danger">{restartError}</span>}
        </div>
      )}

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
      <div ref={scrollRef} className="mx-auto w-full max-w-4xl flex-1 space-y-4 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-5 [touch-action:pan-y]">
        {state === null && (
          <div className="pt-10 text-center text-[12px] text-ink-mute">loading…</div>
        )}
        {state?.messages.length === 0 && pending === null && (
          <div className="pt-10 text-center text-[12px] text-ink-mute">
            session ready — no messages yet
          </div>
        )}
        {hiddenCount > 0 && (
          <div className="flex justify-center pb-1">
            <button
              onClick={() => setExpanded(true)}
              className="rounded-md border border-line px-3 py-1 text-[11.5px] text-ink-mute transition-colors hover:border-gold-dim/60 hover:text-gold"
            >
              show {hiddenCount} earlier message{hiddenCount === 1 ? "" : "s"}
            </button>
          </div>
        )}
        {visibleMessages.map((m) => (
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
          {/* The failure strip sits OUTSIDE the canSend gate: a fire-time send
              failure most often means the session just died — the one state
              where the composer is disabled and the message matters most. */}
          {error && (
            <div className="mb-1.5 text-[11px] text-danger">send failed: {error}</div>
          )}
          {sendNotice && (
            <div className="mb-1.5 text-[11px] text-gold/90">{sendNotice}</div>
          )}
          {composerHint && (
            <div className="mb-1.5 text-[11px] text-gold/90">{composerHint}</div>
          )}
          {(pane?.drift?.length ?? 0) > 0 && (
            <div className="mb-1.5 text-[11px] text-gold/90">
              ⚠ Bifrost couldn't read this Claude Code version's{" "}
              {pane!.drift.join(" + ")} signal — controls may be unreliable; the
              raw terminal is authoritative.
            </div>
          )}
          {gate.canSend ? (
            <>
              {gate.warning && (
                <div className="mb-1.5 text-[11px] text-gold/90">⚠ {gate.warning}</div>
              )}
              <div className="relative">
                {suggestions.length > 0 && (
                  <div className="absolute bottom-full mb-1 max-h-56 w-full overflow-auto rounded-md border border-line bg-panel-raised shadow-lg">
                    {suggestions.map((c) => {
                      // Panel/danger commands can't be driven from chat — dim
                      // them and tag why, so the suggester never silently hands
                      // over a footgun (the composer intercept explains on send).
                      const tag = slashTag(c.name);
                      return (
                        <button
                          key={c.name}
                          onMouseDown={(e) => {
                            e.preventDefault(); // keep textarea focus
                            pickSlash(c.name);
                          }}
                          className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-panel hover:text-gold ${
                            tag === "raw only" || tag === "blocked"
                              ? "text-ink-mute/60"
                              : "text-ink-dim"
                          }`}
                        >
                          <span className="font-mono">{c.name}</span>
                          <span className="text-[10px] text-ink-mute">{tag ?? c.source}</span>
                        </button>
                      );
                    })}
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
                    onChange={(e) => {
                      setComposerHint(null);
                      setText(e.target.value);
                    }}
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
                    <button
                      onClick={() => (modelStrip || modelError ? void closeModel() : void openModel())}
                      disabled={inGrace || modelBusy}
                      title="switch this session's model — never changes your account default"
                      className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40 ${
                        modelStrip
                          ? "border-gold-dim/60 text-gold"
                          : "border-line-soft text-ink-mute hover:border-gold-dim/50 hover:text-ink-dim"
                      }`}
                    >
                      {modelBusy ? "…" : "model"}
                    </button>
                    <button
                      onClick={() => (effortStrip || effortError ? void closeEffort() : void openEffort())}
                      disabled={inGrace || effortBusy}
                      title="set this session's reasoning effort"
                      className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40 ${
                        effortStrip
                          ? "border-gold-dim/60 text-gold"
                          : "border-line-soft text-ink-mute hover:border-gold-dim/50 hover:text-ink-dim"
                      }`}
                    >
                      {effortBusy ? "…" : "effort"}
                    </button>
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
