import { useEffect, useState } from "react";
import type { InteractionState } from "../../../shared/types";
import { sseStream } from "./api";

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
