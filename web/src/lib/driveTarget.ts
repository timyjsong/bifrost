/**
 * Drive-view target resolution — distinguishes the states the old code collapsed
 * into a silent close (audit J8). A drive view opened by deep-link or right after
 * originate points at a session that may not be in the snapshot YET (still
 * settling); the previous logic force-closed on any absence, so a push deep-link
 * to a live session could bounce to the dashboard, and a genuinely-ended session
 * closed with no explanation. This pure resolver separates:
 *   - driving   — the id is in the snapshot; drive it
 *   - resolving — not in the snapshot but within the settle grace, and it was
 *                 never seen present → keep the view mounted (it streams by id)
 *   - gone      — it was present and dropped out (ended mid-drive), OR it never
 *                 appeared within the grace (dead/unknown id) → surface a notice
 */
export type DriveResolution = "driving" | "resolving" | "gone";

export function resolveDriveTarget(i: {
  present: boolean; // id is in the current snapshot
  everPresent: boolean; // it was present at some earlier tick this open
  msSinceOpen: number;
  graceMs: number;
}): DriveResolution {
  if (i.present) return "driving";
  if (i.everPresent) return "gone"; // was live, now ended
  return i.msSinceOpen < i.graceMs ? "resolving" : "gone"; // settling vs never-showed
}

export const DRIVE_SETTLE_GRACE_MS = 6_000;
