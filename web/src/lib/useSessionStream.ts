import { useEffect, useState } from "react";
import type { InteractionState, PaneState } from "../../../shared/types";
import { sseStream } from "./api";
import { getPane } from "./drive";

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

  useEffect(() => {
    if (!sessionId) return;
    setState(null);
    setConnected(false);
    const ac = new AbortController();
    let stopped = false;

    const run = async () => {
      while (!stopped) {
        try {
          for await (const frame of sseStream(
            `/api/session/${encodeURIComponent(sessionId)}/events`,
            ac.signal,
          )) {
            if (frame.event !== "state") continue;
            setConnected(true);
            setState(JSON.parse(frame.data) as InteractionState);
          }
        } catch (err) {
          if (stopped || ac.signal.aborted) return;
          if ((err as Error).message === "unauthenticated") return;
        }
        setConnected(false);
        await new Promise((r) => setTimeout(r, 1500));
      }
    };
    void run();

    return () => {
      stopped = true;
      ac.abort();
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
    let alive = true;
    const tick = async () => {
      const p = await getPane(sessionId);
      if (alive && p) setPane(p);
    };
    void tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sessionId, intervalMs]);
  return pane;
}
