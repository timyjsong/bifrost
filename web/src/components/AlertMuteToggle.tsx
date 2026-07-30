import { useState } from "react";
import { setSessionAlerts } from "../lib/push";

/** Per-session alert mute. Optimistic: flips instantly, falls back to the
 *  server truth (session.alertsEnabled) once the next snapshot lands. Shared
 *  by every sessions view so the mute affordance is identical across shapes. */
export function AlertMuteToggle({
  sessionId,
  enabled,
}: {
  sessionId: string;
  enabled: boolean;
}) {
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  // Drop the override the moment the server agrees. Done during render against
  // the previous prop rather than in an effect: an effect would paint one frame
  // of the stale override first, and the toggle would visibly flicker back.
  const [lastServer, setLastServer] = useState(enabled);
  if (lastServer !== enabled) {
    setLastServer(enabled);
    setOptimistic(null);
  }
  const on = optimistic ?? enabled;
  return (
    <button
      type="button"
      onClick={() => {
        const next = !on;
        setOptimistic(next);
        void setSessionAlerts(sessionId, next).catch(() => setOptimistic(null));
      }}
      title={on ? "alerts on — click to mute this session" : "alerts muted — click to unmute"}
      aria-label={on ? "mute alerts for this session" : "unmute alerts for this session"}
      aria-pressed={!on}
      className={`shrink-0 rounded p-0.5 transition-colors ${
        on ? "text-ink-mute hover:text-gold" : "text-ink-mute/40 hover:text-ink-dim"
      }`}
    >
      {on ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          <path d="M18.63 13A17.89 17.89 0 0 1 18 8" />
          <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
          <path d="M18 8a6 6 0 0 0-9.33-5" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
      )}
    </button>
  );
}
