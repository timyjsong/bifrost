/**
 * Idle-park observe surface — client fetch + the readiness summary. The sweeper
 * runs observe-only until I arm it (lifecycle.enabled); this makes the
 * "would it have parked something I still needed?" evidence visible so the
 * arming call isn't a shell-only guess.
 */
import type { ParkLogEntry, ParkStatus } from "../../../shared/types";
import { apiFetch } from "./api";

export async function fetchParkStatus(): Promise<ParkStatus> {
  return apiFetch("/api/lifecycle/park").then((r) => r.json());
}

export interface ParkSummary {
  observeCount: number;
  killCount: number;
  sessionCount: number; // distinct sessions the sweeper flagged
}

export function summarizePark(entries: ParkLogEntry[]): ParkSummary {
  const sessions = new Set<string>();
  let observeCount = 0;
  let killCount = 0;
  for (const e of entries) {
    sessions.add(e.uuid);
    if (e.mode === "kill") killCount++;
    else observeCount++;
  }
  return { observeCount, killCount, sessionCount: sessions.size };
}
