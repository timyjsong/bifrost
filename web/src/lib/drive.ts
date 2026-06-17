import { apiFetch } from "./api";
import type { PaneState, SlashCommand } from "../../../shared/types";

/**
 * The warn-and-allow gate for prompting a session (AC3.5). Pure, so the contract
 * is tested: non-tmux sessions can't be driven (disabled + reason); an attached or
 * mid-turn session warns but still sends. Attached takes precedence — a client
 * typing in the pane is the real collision, queueing behind a turn is benign.
 */
export interface PromptGate {
  canSend: boolean;
  disabledReason?: string;
  warning?: string;
}

export function promptGate(s: {
  tmuxSession?: string;
  tmuxAttached?: boolean;
  state?: string;
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
  if (s.state === "working") {
    return {
      canSend: true,
      warning: "this session is mid-turn — your prompt will queue behind it",
    };
  }
  return { canSend: true };
}

export interface SendResult {
  ok: boolean;
  reason?: string; // present when !ok
}

export async function sendPrompt(sessionId: string, text: string): Promise<SendResult> {
  try {
    const r = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (r.ok) return { ok: true };
    const j = (await r.json().catch(() => ({}))) as { reason?: string };
    return { ok: false, reason: j.reason ?? `http ${r.status}` };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
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
