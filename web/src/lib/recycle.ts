/**
 * Client wiring for resume (story 2-6) and restart (story 2-7): the POSTs plus
 * PURE response→outcome mapping so the views render exactly what the server
 * decided. The server is the real boundary (fresh liveness probes, per-uuid
 * lock, confirm-before-kill); this layer only translates its structured
 * verdicts into either "open the drive view on this id" or a readable failure.
 */
import { apiFetch } from "./api";

export type RecycleOutcome =
  | { kind: "open-drive"; sessionId: string }
  | { kind: "error"; message: string };

export type RestartMode = "resume" | "fresh";

/**
 * Map a resume response body to a UI outcome. `already-live` opens the drive
 * view on the SAME uuid (AC6.3 — route to drive, never a second claude);
 * every other failure becomes a one-line message naming the cause.
 */
export function resumeOutcome(uuid: string, body: unknown): RecycleOutcome {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.ok === true) {
    return { kind: "open-drive", sessionId: (b.sessionId as string) ?? uuid };
  }
  switch (b.reason) {
    case "already-live":
      return { kind: "open-drive", sessionId: uuid };
    case "already-starting":
      return { kind: "error", message: "Already starting — give it a moment." };
    case "not-resumable":
      return {
        kind: "error",
        message: `Can't resume: ${(b.detail as string) ?? "not resumable"}.`,
      };
    case "degraded":
      return {
        kind: "error",
        message: b.cwd
          ? `Can't resume: its folder is gone (${b.cwd as string}).`
          : `Can't resume: ${(b.detail as string) ?? "folder unreadable"}.`,
      };
    case "spawn-failed":
      return {
        kind: "error",
        message: `Launch failed: ${(b.detail as string) ?? "spawn error"}.`,
      };
    default:
      return { kind: "error", message: "Resume failed — unexpected server reply." };
  }
}

/**
 * Map a restart response body to a UI outcome. On ok the sessionId is the SAME
 * uuid for mode=resume and a NEW one for mode=fresh — the caller just opens it.
 * kill-refused / still-alive mean nothing was relaunched (the server never
 * relaunches onto a live process).
 */
export function restartOutcome(body: unknown): RecycleOutcome {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.ok === true && typeof b.sessionId === "string") {
    return { kind: "open-drive", sessionId: b.sessionId };
  }
  switch (b.reason) {
    case "session-gone":
      return {
        kind: "error",
        message: "The session is already gone — resume it from the Resume pane instead.",
      };
    case "already-starting":
      return { kind: "error", message: "Already restarting — give it a moment." };
    case "kill-refused":
      return { kind: "error", message: "Couldn't stop the old process — nothing was killed." };
    case "still-alive":
      return { kind: "error", message: "The old process didn't die — no relaunch attempted." };
    case "degraded":
      return {
        kind: "error",
        message: `Can't relaunch: ${(b.detail as string) ?? "folder unreadable"}.`,
      };
    case "spawn-failed":
      return {
        kind: "error",
        message: `Relaunch failed: ${(b.detail as string) ?? "spawn error"}.`,
      };
    default:
      return { kind: "error", message: "Restart failed — unexpected server reply." };
  }
}

/** POST resume; any HTTP status carries a structured body the mapper handles. */
export async function resumeSession(uuid: string): Promise<RecycleOutcome> {
  try {
    const res = await apiFetch(`/api/session/${encodeURIComponent(uuid)}/resume`, {
      method: "POST",
    });
    return resumeOutcome(uuid, await res.json());
  } catch {
    return { kind: "error", message: "Could not reach the server." };
  }
}

/** POST restart with the explicit confirm the server requires (AC7.1). */
export async function restartSession(
  uuid: string,
  mode: RestartMode,
): Promise<RecycleOutcome> {
  try {
    const res = await apiFetch(`/api/session/${encodeURIComponent(uuid)}/restart`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, confirm: true }),
    });
    return restartOutcome(await res.json());
  } catch {
    return { kind: "error", message: "Could not reach the server." };
  }
}
