import { apiFetch } from "./api";

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
