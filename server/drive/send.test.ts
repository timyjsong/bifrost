import { afterEach, describe, expect, test } from "bun:test";
import { sendText, sendKey } from "./send";

// Integration test against a THROWAWAY tmux session (never a live work session).
// Skipped where tmux isn't available so the suite still runs in bare CI.
const SESSION = "bifrost-sendtest";

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
async function fresh() {
  await tmuxOut(["kill-session", "-t", SESSION]);
  await tmuxOut(["new-session", "-d", "-s", SESSION, "-x", "80", "-y", "24"]);
  await Bun.sleep(150);
}

const d = (await hasTmux()) ? describe : describe.skip;

d("send executor (throwaway tmux session)", () => {
  afterEach(async () => {
    await tmuxOut(["kill-session", "-t", SESSION]);
  });

  test("multi-line lands intact + un-submitted; a separate submit runs it", async () => {
    await fresh();
    await sendText(SESSION, "echo AAA\necho BBB\necho CCC", { submit: false });
    await Bun.sleep(150);
    const atPrompt = await tmuxOut(["capture-pane", "-p", "-t", SESSION]);
    expect(atPrompt).toContain("echo AAA");
    expect(atPrompt).toContain("echo BBB");
    expect(atPrompt).toContain("echo CCC");
    expect(atPrompt).not.toMatch(/^AAA$/m); // not executed yet

    await sendKey(SESSION, "Enter");
    await Bun.sleep(250);
    const afterRun = await tmuxOut(["capture-pane", "-p", "-t", SESSION]);
    expect(afterRun).toMatch(/^AAA$/m);
    expect(afterRun).toMatch(/^BBB$/m);
    expect(afterRun).toMatch(/^CCC$/m);
  });

  test("metacharacter payload arrives verbatim (delivered literally, not via a shell)", async () => {
    await fresh();
    const tricky = "x=$(whoami); echo `id` && ${PATH} ;|&";
    await sendText(SESSION, tricky, { submit: false });
    await Bun.sleep(150);
    const pane = await tmuxOut(["capture-pane", "-p", "-t", SESSION]);
    expect(pane).toContain(tricky);
  });

  test("submit defaults on: a single line runs", async () => {
    await fresh();
    await sendText(SESSION, "echo ZZZ");
    await Bun.sleep(250);
    const pane = await tmuxOut(["capture-pane", "-p", "-t", SESSION]);
    expect(pane).toMatch(/^ZZZ$/m);
  });

  // The interrupt-restore bug (verified against the live Claude TUI): residual
  // text in the input box must not survive into the next send — each send starts
  // from a clean input. Exercised here with leftover unsubmitted text; without
  // the clear, the editor concatenates the two (OLD<NEW>).
  test("residual input is cleared before the next send (no concatenation)", async () => {
    await fresh();
    await sendText(SESSION, "echo OLDLINE", { submit: false });
    await Bun.sleep(150);
    await sendText(SESSION, "echo NEWLINE", { submit: false });
    await Bun.sleep(150);
    const pane = await tmuxOut(["capture-pane", "-p", "-t", SESSION]);
    expect(pane).toContain("echo NEWLINE");
    // the smoking-gun concatenation the bug produced must never appear
    expect(pane).not.toContain("OLDLINEecho");
  });
});
