import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import Markdown from "react-markdown";
import { relTime } from "../lib/format";

type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; summary: string; asOf: number; cached: boolean }
  | { kind: "error"; message: string };

export function SummaryBlock({
  sessionId,
  lastActivityAt,
  now,
}: {
  sessionId: string;
  lastActivityAt: number;
  now: number;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [open, setOpen] = useState(false);

  async function run() {
    setPhase({ kind: "loading" });
    setOpen(true);
    try {
      const r = await fetch(`/api/sessions/${sessionId}/summarize`, {
        method: "POST",
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        setPhase({ kind: "error", message: d.error ?? `HTTP ${r.status}` });
      } else {
        setPhase({
          kind: "done",
          summary: d.summary,
          asOf: d.asOf,
          cached: d.cached,
        });
      }
    } catch (err) {
      setPhase({ kind: "error", message: String(err) });
    }
  }

  const stale =
    phase.kind === "done" && lastActivityAt - phase.asOf > 60_000;

  return (
    <div className="w-full">
      <div className="flex items-center gap-2">
        <button
          onClick={() =>
            phase.kind === "done" ? setOpen(!open) : phase.kind !== "loading" && run()
          }
          className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-mute transition-colors hover:border-gold-dim/60 hover:text-gold"
        >
          <span className="text-gold/70">✦</span>
          {phase.kind === "loading"
            ? "summarizing…"
            : phase.kind === "done"
              ? open
                ? "hide summary"
                : "show summary"
              : "summarize"}
        </button>
        {stale && (
          <button
            onClick={run}
            className="text-[11px] text-ink-mute underline-offset-2 transition-colors hover:text-gold hover:underline"
          >
            as of {relTime(phase.kind === "done" ? phase.asOf : now, now)} ago — refresh
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && phase.kind !== "idle" && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            style={{ transformOrigin: "top" }}
            className="overflow-hidden"
          >
            <div className="mt-2 rounded-lg border border-line-soft bg-bg/60 px-3.5 py-3">
              {phase.kind === "loading" && (
                <div className="flex items-center gap-2 text-[12px] text-ink-mute">
                  <span className="pulse-dot inline-block size-[6px] rounded-full bg-gold" />
                  haiku is reading the session…
                </div>
              )}
              {phase.kind === "error" && (
                <div className="text-[12px] text-danger">{phase.message}</div>
              )}
              {phase.kind === "done" && (
                <div className="summary-md text-[12.5px] leading-relaxed text-ink-dim">
                  <Markdown>{phase.summary}</Markdown>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
