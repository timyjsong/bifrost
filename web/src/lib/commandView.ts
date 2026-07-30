/**
 * Slash-command turns in a transcript (a typed /model, /clear, …) arrive as
 * XML-ish markup inside a user message, not prose:
 *
 *   <command-name>/model</command-name>
 *   <command-message>model</command-message>
 *   <command-args>opus</command-args>
 *
 * and their local output as <local-command-stdout>…</local-command-stdout>
 * (stderr variant symmetrical). Rendered raw they read as noise — detect and
 * reshape them for a compact command-chip render. The TUI writes STYLED text
 * into command output, so ANSI SGR sequences are stripped.
 */

export type CommandTurn =
  | { kind: "command"; name: string; args: string }
  | { kind: "output"; text: string };

export function stripAnsi(s: string): string {
  // SGR only, anchored on the ESC byte — a bare /\[[0-9;]*m/ would eat the
  // literal "[1m" inside model names like "claude-opus-4-8[1m]".
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Detect a command turn. Anchored to the string START so prose that merely
 *  mentions the tags is never misread as one. Null → render as ordinary text. */
export function parseCommandTurn(text: string): CommandTurn | null {
  if (/^\s*<command-name>/.test(text)) {
    const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
    if (!name) return null;
    return { kind: "command", name: name[1].trim(), args: (args?.[1] ?? "").trim() };
  }
  if (/^\s*<local-command-(stdout|stderr)>/.test(text)) {
    const out = text.match(
      /<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/,
    );
    if (!out) return null;
    return { kind: "output", text: stripAnsi(out[1]).trim() };
  }
  return null;
}
