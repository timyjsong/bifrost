import { afterEach, describe, expect, test } from "bun:test";
import { sendText, sendKey, viewportVerdict, MENU_COLS, MENU_ROWS } from "./send";

// Integration test against a THROWAWAY tmux session (never a live work session).
// Skipped where tmux isn't available so the suite still runs in bare CI.
const SESSION = "bifrost-sendtest";

/** `capture-pane -J` joins wrapped lines. Without it, a long shell prompt plus a
 *  long payload wraps at the pane width and the capture comes back split, so a
 *  verbatim-delivery assertion fails for a reason that has nothing to do with
 *  delivery. CI runners have much longer prompts than a laptop, which is how this
 *  surfaced there and not here. */
async function tmuxOut(args: string[]): Promise<string> {
  const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "ignore" });
  await p.exited;
  return await new Response(p.stdout).text();
}
async function hasTmux(): Promise<boolean> {
  try {
    const p = Bun.spawn(["tmux", "-V"], { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}
/** Poll the pane until `match` holds, or give up and return the last capture so
 *  the caller's expect() reports the real content rather than a timeout. */
async function paneUntil(
  match: (pane: string) => boolean,
  timeoutMs = 4_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let pane = "";
  for (;;) {
    pane = await tmuxOut(["capture-pane", "-p", "-J", "-t", SESSION]);
    if (match(pane) || Date.now() >= deadline) return pane;
    await Bun.sleep(25);
  }
}

async function fresh() {
  await tmuxOut(["kill-session", "-t", SESSION]);
  await tmuxOut(["new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50"]);
  // Wait for a prompt, don't guess at one. A paste that lands before the shell's
  // readline is up is handled by the tty in canonical mode instead, so embedded
  // newlines execute line-by-line — precisely what the first test asserts must
  // NOT happen. A fixed sleep made that a race: the prompt takes ~140ms on a warm
  // laptop and longer on a cold CI runner, so the suite passed locally and failed
  // in CI on exactly those two assertions.
  const ready = await paneUntil((p) => p.trim().length > 0);
  if (!ready.trim()) throw new Error("tmux pane never showed a prompt");
}

const d = (await hasTmux()) ? describe : describe.skip;

d("send executor (throwaway tmux session)", () => {
  afterEach(async () => {
    await tmuxOut(["kill-session", "-t", SESSION]);
  });

  test("multi-line lands intact + un-submitted; a separate submit runs it", async () => {
    await fresh();
    await sendText(SESSION, "echo AAA\necho BBB\necho CCC", { submit: false });
    const atPrompt = await paneUntil((p) => p.includes("echo CCC"));
    expect(atPrompt).toContain("echo AAA");
    expect(atPrompt).toContain("echo BBB");
    expect(atPrompt).toContain("echo CCC");
    expect(atPrompt).not.toMatch(/^AAA$/m); // not executed yet

    await sendKey(SESSION, "Enter");
    const afterRun = await paneUntil((p) => /^CCC$/m.test(p));
    expect(afterRun).toMatch(/^AAA$/m);
    expect(afterRun).toMatch(/^BBB$/m);
    expect(afterRun).toMatch(/^CCC$/m);
  });

  test("metacharacter payload arrives verbatim (delivered literally, not via a shell)", async () => {
    await fresh();
    const tricky = "x=$(whoami); echo `id` && ${PATH} ;|&";
    await sendText(SESSION, tricky, { submit: false });
    const pane = await paneUntil((p) => p.includes(tricky));
    expect(pane).toContain(tricky);
  });

  test("submit defaults on: a single line runs", async () => {
    await fresh();
    await sendText(SESSION, "echo ZZZ");
    const pane = await paneUntil((p) => /^ZZZ$/m.test(p));
    expect(pane).toMatch(/^ZZZ$/m);
  });

  // The interrupt-restore bug (verified against the live Claude TUI): residual
  // text in the input box must not survive into the next send — each send starts
  // from a clean input. Exercised here with leftover unsubmitted text; without
  // the clear, the editor concatenates the two (OLD<NEW>).
  test("residual input is cleared before the next send (no concatenation)", async () => {
    await fresh();
    await sendText(SESSION, "echo OLDLINE", { submit: false });
    await paneUntil((p) => p.includes("echo OLDLINE"));
    await sendText(SESSION, "echo NEWLINE", { submit: false });
    const pane = await paneUntil((p) => p.includes("echo NEWLINE"));
    expect(pane).toContain("echo NEWLINE");
    // the smoking-gun concatenation the bug produced must never appear
    expect(pane).not.toContain("OLDLINEecho");
  });
});

describe("viewportVerdict — tall pickers need the spawn-size window", () => {
  test("full-size window is fine, attached or not", () => {
    expect(viewportVerdict(0, MENU_COLS, MENU_ROWS)).toBe("ok");
    expect(viewportVerdict(2, 240, 60)).toBe("ok");
  });

  test("a small UNATTACHED window may be resized back", () => {
    expect(viewportVerdict(0, 120, 30)).toBe("resize");
    expect(viewportVerdict(0, 220, 30)).toBe("resize");
  });

  test("a small ATTACHED window is left alone (fail honestly, never fight a live terminal)", () => {
    expect(viewportVerdict(1, 120, 30)).toBe("attached-small");
  });
});
