/**
 * The bifrost-chat keymap — what each keystroke MEANS in the prompt input,
 * decoupled from whatever gets injected into the session. Pure, so the mapping is
 * a tested contract; the component executes the returned action (and for
 * "newline" simply lets the textarea's native behavior happen).
 *
 *   enter              → newline   (compose multi-line)
 *   ctrl/cmd + enter   → submit    (schedule the send)
 *   alt + enter        → stop      (cancel within the grace window, else interrupt)
 *   escape             → close     (leave the chat — the draft is preserved)
 *
 * ctrl+c / ctrl+v / ctrl+a stay native (copy / paste / select-all): they return
 * null here, so the handler never preventDefaults them.
 */
export type KeyAction = "submit" | "stop" | "close" | "newline";

export interface KeyChord {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export function resolveKey(e: KeyChord): KeyAction | null {
  if (e.key === "Escape") return "close";
  if (e.key === "Enter") {
    if (e.ctrlKey || e.metaKey) return "submit"; // ctrl/cmd wins
    if (e.altKey) return "stop";
    return "newline"; // plain or shift+enter
  }
  return null;
}

/**
 * What "stop" does given the current phase: cancel a still-parked (grace-window)
 * send, interrupt a running turn, or nothing when idle. Pure companion to the
 * keymap so the dual meaning of the stop action is a tested contract too.
 */
export type SendPhase = "idle" | "pending" | "working";

export function stopAction(phase: SendPhase): "cancel" | "interrupt" | null {
  if (phase === "pending") return "cancel";
  if (phase === "working") return "interrupt";
  return null;
}
