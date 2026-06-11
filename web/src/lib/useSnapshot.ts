import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../../../shared/types";

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
    const es = new EventSource("/api/events");
    es.addEventListener("snapshot", (e) => {
      lastEvent.current = Date.now();
      setConnected(true);
      const next: Snapshot = JSON.parse((e as MessageEvent).data);
      // a new frontend build was deployed — pick it up instead of going stale
      if (next.bundleId) {
        if (bundleId.current && bundleId.current !== next.bundleId) {
          location.reload();
          return;
        }
        bundleId.current = next.bundleId;
      }
      setSnap(next);
    });
    es.onerror = () => setConnected(false);

    // Belt and braces: if the stream goes quiet, poll once and flag it.
    const watchdog = setInterval(async () => {
      if (Date.now() - lastEvent.current < 15_000) return;
      setConnected(false);
      try {
        const r = await fetch("/api/state");
        if (r.ok) setSnap(await r.json());
      } catch {
        // server unreachable; EventSource keeps retrying
      }
    }, 15_000);

    return () => {
      es.close();
      clearInterval(watchdog);
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
