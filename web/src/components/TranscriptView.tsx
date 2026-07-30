/**
 * View-only transcript open for an inactive session (story 2-2, AC2.4).
 *
 * Clicking a recent (dead) session opens its conversation read-only — it reuses
 * the SAME parse/render path as the live drive view: `useSessionStream` streams
 * the server-parsed InteractionState (drive/live.ts reads + parses the transcript
 * file for any indexed session, live or dead), and the shared `Message` renders
 * it. There is no composer here — a dead session has no tmux pane to inject into.
 *
 * The "resume" button is story 2-6's entry point: it POSTs the safety-gated
 * resume (fresh not-live probes + per-uuid lock server-side) and on success
 * hands the session id to `onResume` so the parent swaps this view for the
 * live drive view. An already-live verdict routes the same way (AC6.3);
 * failures render as a one-line strip under the header.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "../../../shared/types";
import { basename, relTime, tildify } from "../lib/format";
import { useSessionStream } from "../lib/useSessionStream";
import { buildToolIndex } from "../lib/toolView";
import { resumeSession } from "../lib/recycle";
import { Message } from "./Transcript";
import {
  isHorizontalBack,
  isCommitted,
  clampDrag,
  shouldComplete,
} from "../lib/gesture";

export function TranscriptView({
  session,
  now,
  onClose,
  onResume,
}: {
  session: SessionInfo;
  now: number;
  onClose: () => void;
  onResume: (sessionId: string) => void;
}) {
  const { state, connected } = useSessionStream(session.sessionId);
  const overlayRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ active: false, committed: false, startX: 0, startY: 0, dx: 0 });
  const [dragX, setDragX] = useState(0);
  const [snapping, setSnapping] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const resume = async () => {
    if (resuming) return;
    setResuming(true);
    setResumeError(null);
    const outcome = await resumeSession(session.sessionId);
    if (outcome.kind === "open-drive") {
      onResume(outcome.sessionId);
    } else {
      setResumeError(outcome.message);
      setResuming(false);
    }
  };
  const toolIndex = useMemo(() => buildToolIndex(state?.messages ?? []), [state]);

  // Lock the page scroll behind the overlay (one scrollbar — the transcript's).
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Esc closes the view (matches the drive view's close key).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // iOS-style horizontal back-swipe — same thresholds as the drive view.
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        drag.current.active = false;
        return;
      }
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
          d.active = false;
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
            <span className="mx-1.5 text-ink-mute/50">·</span>
            last active {relTime(session.lastActivityAt, now)}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2.5">
          <button
            onClick={resume}
            disabled={resuming}
            title="bring this session back live"
            aria-label="resume session"
            className={`rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
              resuming
                ? "border-line text-ink-mute"
                : "border-gold-dim/60 text-gold hover:bg-gold-dim/10"
            }`}
          >
            {resuming ? "resuming…" : "resume"}
          </button>
          <span className="text-[11px] text-ink-mute">view-only</span>
        </div>
      </header>
      {resumeError && (
        <div className="border-b border-line-soft bg-danger/10 px-4 py-1.5 text-[12px] text-danger">
          {resumeError}
        </div>
      )}

      <div className="mx-auto w-full max-w-4xl flex-1 space-y-4 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-5 [touch-action:pan-y]">
        {state === null && (
          <div className="pt-10 text-center text-[12px] text-ink-mute">
            {connected ? "loading…" : "reading transcript…"}
          </div>
        )}
        {state?.messages.length === 0 && (
          <div className="pt-10 text-center text-[12px] text-ink-mute">
            no conversation in this transcript
          </div>
        )}
        {state?.messages.map((m) => (
          <Message key={m.uuid} m={m} tools={toolIndex} />
        ))}
      </div>
    </div>
  );
}
