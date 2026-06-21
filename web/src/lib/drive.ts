import { apiFetch } from "./api";
import type { PaneState, SlashCommand } from "../../../shared/types";

/**
 * The gate for whether a session can be driven at all (AC3.5). Pure, so the
 * contract is tested: non-tmux sessions can't be driven (disabled + reason); an
 * attached session warns but still sends (collision risk with the desktop GUI).
 * The `working` state is handled in the UI, not here — send becomes stop and the
 * input is disabled, so there's no queueing to warn about.
 */
export interface PromptGate {
  canSend: boolean;
  disabledReason?: string;
  warning?: string;
}

export function promptGate(s: {
  tmuxSession?: string;
  tmuxAttached?: boolean;
}): PromptGate {
  if (!s.tmuxSession) {
    return {
      canSend: false,
      disabledReason: "not tmux-resident — Bifrost can only drive sessions running in tmux",
    };
  }
  if (s.tmuxAttached) {
    return {
      canSend: true,
      warning: "a client is attached (likely your desktop GUI) — sending may collide with typing there",
    };
  }
  return { canSend: true };
}

export interface SendResult {
  ok: boolean;
  reason?: string; // present when !ok
}

export interface ScheduleResult extends SendResult {
  /** Grace period (ms) the server parked the send for — the UI's countdown. */
  delayMs?: number;
}

/**
 * Submit a prompt. The server PARKS it for a grace period and returns how long
 * (delayMs); it injects when the window elapses unless cancelled first. A 409
 * (non-injectable / vanished) or other error comes back as { ok:false, reason }.
 */
export async function schedulePrompt(sessionId: string, text: string): Promise<ScheduleResult> {
  try {
    const r = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (r.ok) {
      const j = (await r.json().catch(() => ({}))) as { delayMs?: number };
      return { ok: true, delayMs: j.delayMs };
    }
    const j = (await r.json().catch(() => ({}))) as { reason?: string };
    return { ok: false, reason: j.reason ?? `http ${r.status}` };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/**
 * Cancel a parked send within its grace window (the "undo"). `cancelled:true`
 * means it was truly aborted (restore the user's text); `cancelled:false` means
 * it had already fired — treat it as sent, don't restore.
 */
export async function cancelPrompt(
  sessionId: string,
): Promise<{ ok: boolean; cancelled: boolean }> {
  try {
    const r = await apiFetch(
      `/api/session/${encodeURIComponent(sessionId)}/prompt/cancel`,
      { method: "POST" },
    );
    if (!r.ok) return { ok: false, cancelled: false };
    const j = (await r.json().catch(() => ({}))) as { cancelled?: boolean };
    return { ok: true, cancelled: !!j.cancelled };
  } catch {
    return { ok: false, cancelled: false };
  }
}

/** Interrupt a running turn (sends Esc server-side). Only fired by the stop
 *  button, which the drive view shows solely while the session is working. */
export async function interrupt(sessionId: string): Promise<SendResult> {
  try {
    const r = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, {
      method: "POST",
    });
    if (r.ok) return { ok: true };
    const j = (await r.json().catch(() => ({}))) as { reason?: string };
    return { ok: false, reason: j.reason ?? `http ${r.status}` };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Read the live pane state (pending permission menu + raw tail for fallback). */
export async function getPane(sessionId: string): Promise<PaneState | null> {
  try {
    const r = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/pane`);
    if (!r.ok) return null;
    return (await r.json()) as PaneState;
  } catch {
    return null;
  }
}

/** Answer a permission menu (a digit, or "Enter" for the default). */
export async function answer(sessionId: string, key: string): Promise<SendResult> {
  try {
    const r = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (r.ok) return { ok: true };
    const j = (await r.json().catch(() => ({}))) as { reason?: string };
    return { ok: false, reason: j.reason ?? `http ${r.status}` };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Full pane content (with colour escapes) for the xterm.js raw mirror. */
export async function getCapture(sessionId: string): Promise<string | null> {
  try {
    const r = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/capture`);
    if (!r.ok) return null;
    return ((await r.json()) as { text?: string }).text ?? "";
  } catch {
    return null;
  }
}

export async function getSlashCommands(sessionId: string): Promise<SlashCommand[]> {
  try {
    const r = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/slash`);
    if (!r.ok) return [];
    return ((await r.json()) as { commands?: SlashCommand[] }).commands ?? [];
  } catch {
    return [];
  }
}

/**
 * Suggestions for the current input, or [] when not typing a slash command.
 * Suggests only while the input is "/" + non-space (the command token, no args
 * yet); substring match, prefix matches ranked first, capped at 8. Pure +
 * client-side — zero network per keystroke. Never gates: type past it and send.
 */
export function filterSlash(input: string, commands: SlashCommand[]): SlashCommand[] {
  const m = input.match(/^\/(\S*)$/);
  if (!m) return [];
  const q = m[1].toLowerCase();
  return commands
    .filter((c) => c.name.toLowerCase().slice(1).includes(q))
    .sort((a, b) => {
      const ap = a.name.toLowerCase().slice(1).startsWith(q) ? 0 : 1;
      const bp = b.name.toLowerCase().slice(1).startsWith(q) ? 0 : 1;
      return ap - bp || a.name.localeCompare(b.name);
    })
    .slice(0, 8);
}

export async function getDraft(sessionId: string): Promise<string> {
  try {
    const r = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/draft`);
    if (!r.ok) return "";
    return ((await r.json()) as { text?: string }).text ?? "";
  } catch {
    return "";
  }
}

export async function saveDraft(sessionId: string, text: string): Promise<void> {
  try {
    await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {
    /* draft save is best-effort — losing one keystroke's sync is harmless */
  }
}

export interface DraftSync {
  /** Whether to replace the textarea with `value`. */
  adopt: boolean;
  value: string;
  /** The new last-synced baseline to remember (what the server now holds). */
  baseline: string;
}

/**
 * Decide how a freshly-polled server draft reconciles with this device's state,
 * so live cross-device sync never clobbers what you're typing. Inputs: `local`
 * (the textarea now), `lastSynced` (the value this device last PUT or adopted),
 * `remote` (what the poll just read).
 *
 *  - remote === lastSynced → nothing changed elsewhere since our baseline → keep
 *    local (we may have un-saved keystrokes the server hasn't seen yet).
 *  - remote === local → already showing it → don't touch the box, just advance
 *    the baseline so we stop re-comparing.
 *  - otherwise → a genuine edit from another device → adopt it.
 *
 * Last-write-wins: a remote edit overwrites un-saved local keystrokes. Acceptable
 * — single user across their own devices; matches the server's last-write-wins
 * draft store (no conflict UI).
 */
export function reconcileDraft(args: {
  local: string;
  lastSynced: string;
  remote: string;
}): DraftSync {
  const { local, lastSynced, remote } = args;
  if (remote === lastSynced) return { adopt: false, value: local, baseline: lastSynced };
  if (remote === local) return { adopt: false, value: local, baseline: remote };
  return { adopt: true, value: remote, baseline: remote };
}
