import { useEffect, useRef, useState } from "react";
import type { InteractionState, PaneState } from "../../../shared/types";
import { sseStream } from "./api";
import { getPane } from "./drive";
import { SESSION_QUIET_MS, streamQuiet } from "./staleness";
import { startGuardedPoll } from "./poll";

export interface SessionStreamState {
  state: InteractionState | null;
  connected: boolean;
}

/**
 * Live interaction state for one session, over the per-session SSE
 * (`/api/session/:id/events`). Mirrors useSnapshot's owned-retry loop: the
 * server sends the FULL state on every push, so a reconnect just replaces the
 * state — no missing or duplicated blocks (AC2.4). Passing `null` tears the
 * stream down (the drive view is closed).
 */
export function useSessionStream(sessionId: string | null): SessionStreamState {
  const [state, setState] = useState<InteractionState | null>(null);
  const [connected, setConnected] = useState(false);

  const lastEvent = useRef(0);
  // Messages the client already holds — passed as ?since= on a RECONNECT so the
  // server ships only the delta, not the whole transcript (the mobile re-ship
  // cliff). Kept in sync with `state` synchronously as frames arrive.
  const countRef = useRef(0);

  useEffect(() => {
    if (!sessionId) return;
    setState(null);
    setConnected(false);
    countRef.current = 0;
    let stopped = false;
    // Per-attempt controller so the watchdog can kill a hung stream and the
    // loop redials — a frozen transcript that still says "live" is exactly the
    // failure this guards against.
    let attempt: AbortController | null = null;

    const run = async () => {
      while (!stopped) {
        attempt = new AbortController();
        lastEvent.current = Date.now(); // quiet counts from connection open
        // On a reconnect the client already holds countRef.current messages;
        // ask the server to resume from there instead of re-shipping all.
        const since = countRef.current;
        const q = since > 0 ? `?since=${since}` : "";
        try {
          for await (const frame of sseStream(
            `/api/session/${encodeURIComponent(sessionId)}/events${q}`,
            attempt.signal,
          )) {
            lastEvent.current = Date.now(); // ANY frame — pings included
            if (frame.event === "state") {
              const parsed = JSON.parse(frame.data) as InteractionState;
              countRef.current = parsed.messages.length;
              setConnected(true);
              setState(parsed);
            } else if (frame.event === "append") {
              // Incremental delta: replace messages from fromIndex with the
              // changed tail (the last open turn may have grown + new turns).
              const d = JSON.parse(frame.data) as {
                fromIndex: number;
                messages: InteractionState["messages"];
              };
              countRef.current = d.fromIndex + d.messages.length;
              setConnected(true);
              setState((prev) =>
                prev
                  ? { ...prev, messages: [...prev.messages.slice(0, d.fromIndex), ...d.messages] }
                  : null,
              );
            }
          }
        } catch (err) {
          if (stopped) return;
          if ((err as Error).message === "unauthenticated") return;
        }
        if (stopped) return;
        setConnected(false);
        await new Promise((r) => setTimeout(r, 1500));
      }
    };
    void run();

    // This stream pushes only on transcript writes, so the 25s heartbeat is
    // the liveness floor: silence past the threshold means hung — redial.
    const watchdog = setInterval(() => {
      if (!streamQuiet(lastEvent.current, Date.now(), SESSION_QUIET_MS)) return;
      setConnected(false);
      attempt?.abort();
    }, 5_000);

    return () => {
      stopped = true;
      attempt?.abort();
      clearInterval(watchdog);
    };
  }, [sessionId]);

  return { state, connected };
}

/**
 * Poll the live pane (Channel 3) while the drive view is open — the pending
 * permission menu isn't in the transcript, so it needs its own read. A short
 * interval is fine: approvals aren't sub-second and capture-pane is cheap.
 */
export function usePaneState(
  sessionId: string | null,
  intervalMs = 700,
): PaneState | null {
  const [pane, setPane] = useState<PaneState | null>(null);
  useEffect(() => {
    if (!sessionId) {
      setPane(null);
      return;
    }
    // Guarded: never overlaps its own request on a slow link (was setInterval).
    return startGuardedPoll(async () => {
      const p = await getPane(sessionId);
      if (p) setPane(p);
    }, intervalMs);
  }, [sessionId, intervalMs]);
  return pane;
}
