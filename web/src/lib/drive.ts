import { apiFetch } from "./api";
import type { PaneState, PermissionMode, SlashCommand } from "../../../shared/types";
import { classifySlash } from "./slashPanels";

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
  /** The POST threw (network drop) instead of returning an HTTP status, so the
   *  server may have parked the send even though the client saw an error. */
  indeterminate?: boolean;
}

export type SendOutcome = "parked" | "rejected" | "indeterminate";

/**
 * How the submit UI should treat a schedulePrompt result:
 * - `parked` — accepted; ride the grace window.
 * - `rejected` — the server refused it (409 / other HTTP error); it definitely
 *   did NOT park, so it's safe to restore the user's text.
 * - `indeterminate` — the request threw before any status came back; the server
 *   MAY have parked it and will fire, so the text must NOT be auto-restored (a
 *   blind resend would double-send). Reconciles via `pane.pendingSend` / the
 *   transcript instead.
 */
export function sendOutcome(res: ScheduleResult): SendOutcome {
  if (res.ok) return "parked";
  return res.indeterminate ? "indeterminate" : "rejected";
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
    return { ok: false, indeterminate: true, reason: (e as Error).message };
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

/** Set the session's permission mode (auto / accept-edits / plan). The server
 *  injects the right number of Shift+Tab presses; bypass is launch-only and
 *  rejected. Returns whether it took. */
export async function setMode(sessionId: string, mode: PermissionMode): Promise<boolean> {
  try {
    const r = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    return r.ok;
  } catch {
    return false;
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

export type SendFailure = { at: number; reason: string };

export type DraftState = { text: string; sendFailure: SendFailure | null };

export async function getDraft(sessionId: string): Promise<DraftState> {
  try {
    const r = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/draft`);
    if (!r.ok) return { text: "", sendFailure: null };
    const body = (await r.json()) as { text?: string; sendFailure?: SendFailure | null };
    return { text: body.text ?? "", sendFailure: body.sendFailure ?? null };
  } catch {
    return { text: "", sendFailure: null };
  }
}

/**
 * One line for the failure strip when a parked send failed at fire time (the
 * strip itself prefixes "send failed:"). The server keeps the unsent text in
 * the session's draft — it fills the composer again as soon as the session is
 * sendable (including after a resume).
 */
export function sendFailureMessage(reason: string): string {
  switch (reason) {
    case "session-gone":
    case "not-injectable":
      return "the session wasn't running when the timer fired — your text is kept in the draft";
    case "send-error":
      return "the message couldn't be injected — your text is kept in the draft";
    default:
      return "the parked send didn't land — your text is kept in the draft";
  }
}

/**
 * PUT the draft. Returns whether the server accepted it — the caller advances
 * its sync baseline ONLY on success, so a failed PUT doesn't move the baseline
 * ahead of what the server actually holds (which would make the receive-poll
 * adopt the stale server value over newer local text — audit M1/J6).
 */
export async function saveDraft(sessionId: string, text: string): Promise<boolean> {
  try {
    const r = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return r.ok;
  } catch {
    return false; // best-effort — the baseline stays put, local text is preserved
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

export interface UploadedFile {
  /** Absolute server-side path — injected into the prompt for Claude to read. */
  path: string;
  /** Stored filename (shown on the composer chip). */
  name: string;
}

/**
 * Upload attachment files for a session. Returns the saved files; the composer
 * injects their path(s) into the prompt, since the tmux TUI can't take binaries.
 * Best-effort — a failure returns [] (FormData sets its own multipart boundary,
 * so no content-type header here).
 */
export async function uploadFiles(
  sessionId: string,
  files: File[],
): Promise<UploadedFile[]> {
  const form = new FormData();
  for (const f of files) form.append("file", f);
  try {
    const r = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/upload`, {
      method: "POST",
      body: form,
    });
    if (!r.ok) return [];
    return ((await r.json()) as { files?: UploadedFile[] }).files ?? [];
  } catch {
    return [];
  }
}

// ── rewind (checkpoints) ───────────────────────────────────────────────────────

export interface RewindCheckpoint {
  label: string;
  detail: string;
}

export type RewindOpenResult =
  | { ok: true; checkpoints: RewindCheckpoint[]; cursorIndex: number }
  | { ok: false; reason: string };

export async function rewindOpen(sessionId: string): Promise<RewindOpenResult> {
  try {
    const r = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/rewind/open`, {
      method: "POST",
    });
    return (await r.json()) as RewindOpenResult;
  } catch {
    return { ok: false, reason: "network" };
  }
}

/** A picker commit outcome. `reason: "gone"` means the choice is no longer
 *  offered by the live picker (the list shifted since the peek). */
export interface SelectResult {
  ok: boolean;
  reason?: string;
}

/** Commit a rewind by the checkpoint's IDENTITY (label + detail), not the
 *  peek-time index — the checkpoint list can grow between peek and commit, and
 *  restoring to the wrong point is destructive. */
export async function rewindSelect(
  sessionId: string,
  choice: { label: string; detail: string },
): Promise<SelectResult> {
  try {
    const r = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/rewind/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(choice),
    });
    return (await r.json()) as SelectResult;
  } catch {
    return { ok: false, reason: "network" };
  }
}

export async function rewindCancel(sessionId: string): Promise<void> {
  try {
    await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/rewind/cancel`, {
      method: "POST",
    });
  } catch {
    /* best-effort */
  }
}

// ── model switching (session-scoped) ──────────────────────────────────────────

export interface ModelOption {
  label: string;
  detail: string;
  current: boolean;
}

export type ModelOpenResult =
  | { ok: true; options: ModelOption[]; cursorIndex: number }
  | { ok: false; reason: string };

export async function modelOpen(sessionId: string): Promise<ModelOpenResult> {
  try {
    const r = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/model/open`, {
      method: "POST",
    });
    return (await r.json()) as ModelOpenResult;
  } catch {
    return { ok: false, reason: "network" };
  }
}

/** Commit a model by its row LABEL (not the peek-time index). */
export async function modelSelect(sessionId: string, label: string): Promise<SelectResult> {
  try {
    const r = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/model/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    });
    return (await r.json()) as SelectResult;
  } catch {
    return { ok: false, reason: "network" };
  }
}

export async function modelCancel(sessionId: string): Promise<void> {
  try {
    await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/model/cancel`, {
      method: "POST",
    });
  } catch {
    /* best-effort */
  }
}

// ── effort switching (session-scoped) ─────────────────────────────────────────

export type EffortOpenResult =
  | { ok: true; options: string[]; currentIndex: number }
  | { ok: false; reason: string };

export async function effortOpen(sessionId: string): Promise<EffortOpenResult> {
  try {
    const r = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/effort/open`, {
      method: "POST",
    });
    return (await r.json()) as EffortOpenResult;
  } catch {
    return { ok: false, reason: "network" };
  }
}

/** Commit an effort by its stop LABEL (not the peek-time index). */
export async function effortSelect(sessionId: string, value: string): Promise<SelectResult> {
  try {
    const r = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/effort/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });
    return (await r.json()) as SelectResult;
  } catch {
    return { ok: false, reason: "network" };
  }
}

export async function effortCancel(sessionId: string): Promise<void> {
  try {
    await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/effort/cancel`, {
      method: "POST",
    });
  } catch {
    /* best-effort */
  }
}

/** UI copy for a picker-open OR commit failure (rewind / model / effort).
 *  "attached-small" and "busy" and "gone" have specific, actionable causes; the
 *  rest fall back to the version-changed guidance. */
export function menuFailureMessage(reason: string, what: string): string {
  if (reason === "attached-small") {
    return `couldn't read the ${what} — a terminal is attached to this session at a small window size; detach or enlarge it and retry, or use the raw terminal`;
  }
  if (reason === "busy") {
    return `the session is mid-turn — wait for it to finish, then reopen the ${what}`;
  }
  if (reason === "gone") {
    return `that choice is no longer available — the ${what} changed since you opened it; reopen and pick again`;
  }
  return `couldn't read the ${what} — this Claude Code version may have changed it; use the raw terminal`;
}

/**
 * Composer guard. THE RULE (my call, 2026-07-02): a slash command that opens an
 * interactive TUI panel can't work through the chat — those get a Bifrost UI
 * control instead, or a pointer to the raw terminal; a few would end/disrupt
 * the session and are refused. Classification is single-sourced in
 * ./slashPanels. Returns the hint to show, or null to let the text through.
 */
export function interceptComposer(text: string): string | null {
  const m = text.trim().match(/^(\/[a-z-]+)(?:\s|$)/i);
  if (!m) return null;
  return classifySlash(m[1])?.hint ?? null;
}

// ── session diff (review spine) ────────────────────────────────────────────────

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

export type SessionDiffState =
  | { git: false }
  | { git: true; stat: DiffStat; diff: string; truncated: boolean };

export async function getSessionDiff(sessionId: string): Promise<SessionDiffState> {
  try {
    const r = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/diff`);
    if (!r.ok) return { git: false };
    return (await r.json()) as SessionDiffState;
  } catch {
    return { git: false };
  }
}

/** Row class for a unified-diff line — pure so the render rule is tested. */
export function diffLineKind(line: string): "add" | "del" | "hunk" | "meta" | "ctx" {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index "))
    return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}
