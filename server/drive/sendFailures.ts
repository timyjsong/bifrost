/**
 * Fire-time send failures — the record a device polls (via the draft endpoint)
 * to learn that a parked send never landed. In-memory like the pending-send
 * registry it mirrors: a failure matters for the minutes after it happens, not
 * across service restarts. Keyed by sessionId. A new schedule for the session
 * clears it (a fresh attempt supersedes the old failure) and a successful fire
 * clears it; reads never clear it, so every device gets to see it and each
 * acks locally by the `at` timestamp.
 */
export type SendFailure = { at: number; reason: string };

const failures = new Map<string, SendFailure>();

export function recordSendFailure(
  sessionId: string,
  reason: string,
  at: number = Date.now(),
): void {
  failures.set(sessionId, { at, reason });
}

export function sendFailure(sessionId: string): SendFailure | null {
  return failures.get(sessionId) ?? null;
}

export function clearSendFailure(sessionId: string): void {
  failures.delete(sessionId);
}
