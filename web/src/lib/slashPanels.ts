/**
 * Slash-command classification — my rule (2026-07-02): a slash command that
 * opens an interactive TUI panel can't work through the chat (the panel blocks
 * the pane until Esc), so it must NOT be injectable from the composer. Those get
 * a Bifrost UI control where one exists, or a pointer to the raw terminal where
 * one doesn't. A few commands end/disrupt the session and are refused outright.
 *
 * Behavior verified LIVE (2026-07-03, Claude Code v2.1.198, throwaway session):
 *  - panel-openers that BLOCK on a picker until Esc: /config /status /mcp /cost
 *    /help (each rendered a footer like "Esc to cancel" / "Esc to close").
 *  - return-to-idle (safe to inject; stream or one-shot): /context /agents.
 * The rest are classified from their well-established behavior; anything not
 * listed passes through unchanged (/clear, /compact, /init, /review, … stream
 * to the transcript and work fine in chat).
 */

export type SlashClass =
  | { kind: "control"; hint: string } // a Bifrost UI control does this instead
  | { kind: "panel"; hint: string } // TUI-only panel — reach it via the raw terminal
  | { kind: "danger"; hint: string }; // would end/disrupt this session

// Commands with a first-class Bifrost control (a 1:1 replacement).
const CONTROL: Record<string, string> = {
  "/model":
    "model switching lives in the model pill below — it changes this session only, never your account default",
  "/effort": "reasoning effort lives in the effort pill below — it changes this session only",
  "/rewind": "checkpoints live behind the rewind button in the header",
};

// Panel-openers with no Bifrost control yet — reachable only via the raw
// terminal. The hint names the command so a filled-then-blocked suggestion is
// self-explaining.
const PANEL = new Set(["/config", "/status", "/mcp", "/cost", "/help", "/memory", "/resume"]);

// Commands that would end or disrupt the session if injected.
const DANGER: Record<string, string> = {
  "/exit": "/exit would end this session — use restart if you want a fresh one",
  "/quit": "/quit would end this session — use restart if you want a fresh one",
  "/logout": "/logout would sign this machine's Claude out — do it from a real terminal, not here",
  "/login": "/login opens an auth flow that can't be driven from chat — use a real terminal",
};

/** Classify a slash command by its leading token. Null → safe to send as-is. */
export function classifySlash(name: string): SlashClass | null {
  const cmd = name.trim().toLowerCase();
  if (CONTROL[cmd]) return { kind: "control", hint: CONTROL[cmd] };
  if (DANGER[cmd]) return { kind: "danger", hint: DANGER[cmd] };
  if (PANEL.has(cmd))
    return {
      kind: "panel",
      hint: `${cmd} opens a Claude Code panel Bifrost can't drive from chat yet — open the raw terminal (the “raw” toggle) to use it`,
    };
  return null;
}

/** Short suggester tag for a classified command (null → not classified). */
export function slashTag(name: string): string | null {
  const c = classifySlash(name);
  if (!c) return null;
  return c.kind === "control" ? "in-app" : c.kind === "panel" ? "raw only" : "blocked";
}
