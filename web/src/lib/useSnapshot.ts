import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../../../shared/types";
import { apiFetch, sseStream } from "./api";
import { SNAPSHOT_QUIET_MS, streamQuiet } from "./staleness";

export interface SnapshotState {
  snap: Snapshot | null;
  connected: boolean;
}

export function useSnapshot(): SnapshotState {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const lastEvent = useRef(0);
  const bundleId = useRef<number | undefined>(undefined);

  useEffect(() => {
    // A new frontend build changes bundleId — reload to pick it up rather than
    // sit on a stale page. Checked on EVERY refresh path (stream, watchdog poll,
    // and foreground) so a backgrounded tab that dropped the stream — the phone
    // PWA case — still self-heals instead of running old code with fresh data.
    // Returns true when it triggered a reload, so callers skip the stale setSnap.
    const applyBundle = (next: Snapshot): boolean => {
      if (!next.bundleId) return false;
      if (bundleId.current && bundleId.current !== next.bundleId) {
        location.reload();
        return true;
      }
      bundleId.current = next.bundleId;
      return false;
    };

    let stopped = false;
    // Per-attempt controller so the watchdog can kill a HUNG stream (half-dead
    // TCP: reader pending forever, no FIN) and the loop redials — the old
    // single controller could only tear down on unmount.
    let attempt: AbortController | null = null;

    const pollState = async () => {
      try {
        const r = await apiFetch("/api/state");
        if (!r.ok) return;
        const next: Snapshot = await r.json();
        if (applyBundle(next)) return;
        setSnap(next);
      } catch {
        // server unreachable, or auth lost (the enroll screen takes over)
      }
    };

    // The live stream, over fetch (so the token header rides along). EventSource
    // would auto-reconnect; here we own the retry loop — reconnect after a beat
    // whenever the stream ends, errors, or is watchdog-aborted for silence.
    const run = async () => {
      while (!stopped) {
        attempt = new AbortController();
        lastEvent.current = Date.now(); // quiet counts from connection open
        try {
          for await (const frame of sseStream("/api/events", attempt.signal)) {
            lastEvent.current = Date.now(); // ANY frame — pings included
            if (frame.event !== "snapshot") continue;
            setConnected(true);
            const next: Snapshot = JSON.parse(frame.data);
            if (applyBundle(next)) return; // reloading — stop the loop
            setSnap(next);
          }
        } catch (err) {
          if (stopped) return;
          if ((err as Error).message === "unauthenticated") return; // enroll takes over
        }
        if (stopped) return;
        setConnected(false);
        await new Promise((r) => setTimeout(r, 2000));
      }
    };
    void run();

    // The watchdog: silence past the threshold means the stream is hung, not
    // idle (snapshots push every few seconds, heartbeats every 25s). Flag it,
    // poll once for fresh data, and abort the attempt so the loop redials.
    const watchdog = setInterval(() => {
      if (!streamQuiet(lastEvent.current, Date.now(), SNAPSHOT_QUIET_MS)) return;
      setConnected(false);
      void pollState();
      attempt?.abort();
    }, 5_000);

    // Mobile suspends the stream when backgrounded; re-check for a new build the
    // moment the app is foregrounded, so it never lingers on a stale bundle.
    const onVisible = () => {
      if (document.visibilityState === "visible") void pollState();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      attempt?.abort();
      clearInterval(watchdog);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return { snap, connected };
}

/** A once-a-second clock, for relative timestamps and the header. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
