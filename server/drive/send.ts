/**
 * The send executor — Channel 2 (input). Delivers literal text into a tmux pane
 * via a bracketed-paste buffer (verified on a throwaway session: multi-line
 * lands intact and un-submitted regardless of embedded newlines), then submits
 * with a SEPARATE Enter. argv-not-shell throughout; the payload travels on STDIN
 * (`load-buffer -`), never in argv, so no shell metacharacter can act.
 *
 * This module is impure (it spawns tmux); the security decision of WHETHER a
 * target may be driven lives in the pure resolver (./target.ts). Callers must
 * resolve a validated target there first and pass the result here.
 */
import { randomBytes } from "node:crypto";

/** Run a tmux subcommand by argv (never a shell string). Optional stdin bytes
 *  feed the payload to `load-buffer -` without it ever touching argv. Throws on
 *  non-zero exit with tmux's stderr, so a dead target fails loud, not silent. */
async function tmux(args: string[], stdin?: string): Promise<void> {
  const proc = Bun.spawn(["tmux", ...args], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = (await new Response(proc.stderr).text()).trim();
    throw new Error(`tmux ${args[0]} failed: ${err || `exit ${code}`}`);
  }
}

export interface SendOpts {
  /** Press Enter after pasting to submit the turn. Default true. */
  submit?: boolean;
}

/**
 * Empty the pane's input editor before a paste, so a new prompt never lands on
 * top of leftover text and gets submitted concatenated. The motivating residue
 * (verified against the live Claude TUI): pressing Esc to interrupt a turn
 * RESTORES the interrupted prompt back into the input box.
 *
 * C-u kills to line-start (one logical line); we loop because a restored
 * multi-line prompt spans several, stopping as soon as a press changes nothing
 * (box already empty). C-u is the load-bearing choice: it's a SAFE no-op on an
 * empty box, whereas C-c — tried first — arms "Ctrl-C again to exit", a mode that
 * SWALLOWS the very next paste (the common empty-box case broke), and Esc-Esc
 * opens the rewind menu on an empty box. A short settle after each press lets Ink
 * process it before we read the pane or paste (back-to-back input races it).
 */
async function clearInput(target: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const before = await capturePane(target);
    await tmux(["send-keys", "-t", target, "C-u"]);
    await Bun.sleep(60);
    if ((await capturePane(target)) === before) return; // nothing left to kill
  }
}

/**
 * Paste `text` into `target`'s active pane as one bracketed-paste unit, then
 * (by default) submit. `target` must already be validated by resolveTarget.
 * Clears any residual input first (see clearInput).
 */
export async function sendText(
  target: string,
  text: string,
  opts: SendOpts = {},
): Promise<void> {
  await clearInput(target);
  const buf = `bifrost-${randomBytes(6).toString("hex")}`;
  await tmux(["load-buffer", "-b", buf, "-"], text);
  // -p: bracketed paste (the TUI sees a paste, not typed input → embedded
  //     newlines don't submit line-by-line). -d: drop the buffer after pasting.
  await tmux(["paste-buffer", "-p", "-d", "-b", buf, "-t", target]);
  if (opts.submit ?? true) {
    await Bun.sleep(60); // let the paste land before Enter (multi-line can lag)
    await tmux(["send-keys", "-t", target, "Enter"]);
  }
}

/**
 * Send a single tmux key spec to `target` — e.g. "Escape" to interrupt, or a
 * digit for a permission-menu selection. The key name is a tmux key spec, not
 * text, and travels by argv; there is nothing to escape.
 */
export async function sendKey(target: string, key: string): Promise<void> {
  await tmux(["send-keys", "-t", target, key]);
}

// The spawn size (spawn/spawn.ts argv builders). The TUI's tall full-screen
// pickers (rewind, model) clip their header/footer when the window is smaller —
// an attached client shrinks it and the size can outlive the detach.
export const MENU_COLS = 220;
export const MENU_ROWS = 50;

export type ViewportVerdict = "ok" | "resize" | "attached-small";

/** Pure decision: can `target`'s window render a tall picker, and if not, may
 *  we resize it? A window held small by an ATTACHED client is left alone —
 *  resizing under a live human terminal is worse than failing loud. */
export function viewportVerdict(
  attached: number,
  width: number,
  height: number,
): ViewportVerdict {
  if (width >= MENU_COLS && height >= MENU_ROWS) return "ok";
  return attached > 0 ? "attached-small" : "resize";
}

/** Restore an unattached window to the spawn size before opening a tall picker.
 *  Returns false when an attached client pins it small — the caller surfaces
 *  that as the failure reason instead of a misparse. */
export async function ensureMenuViewport(target: string): Promise<boolean> {
  const proc = Bun.spawn(
    [
      "tmux", "display-message", "-p", "-t", target,
      "#{session_attached} #{window_width} #{window_height}",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const [att, w, h] = out.trim().split(/\s+/).map(Number);
  const verdict = viewportVerdict(att || 0, w || 0, h || 0);
  if (verdict === "ok") return true;
  if (verdict === "attached-small") return false;
  await tmux(["resize-window", "-t", target, "-x", String(MENU_COLS), "-y", String(MENU_ROWS)]);
  await Bun.sleep(250); // let Ink redraw at the new size
  return true;
}

/** Poll `read` until it yields non-null. Full-screen pickers can render slowly
 *  under load (service startup, big scrollback) — a single fixed-delay capture
 *  races that and a premature give-up Esc leaves the command text restored in
 *  the input box. */
export async function pollPane<T>(
  read: () => Promise<T | null>,
  tries = 12,
  intervalMs = 400,
): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    const r = await read();
    if (r) return r;
    await Bun.sleep(intervalMs);
  }
  return null;
}

/** Read the visible content of a pane (Channel 3 — ephemeral TUI state not in
 *  the transcript, e.g. a pending permission menu). Read-only. With
 *  `escapes`, includes SGR colour sequences for the xterm.js raw mirror; without,
 *  plain text for the menu parser. */
export async function capturePane(
  target: string,
  opts: { escapes?: boolean } = {},
): Promise<string> {
  const args = ["capture-pane", ...(opts.escapes ? ["-e"] : []), "-p", "-t", target];
  const proc = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}
