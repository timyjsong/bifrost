import { describe, expect, test } from "bun:test";
import { promptGate } from "./drive";

describe("promptGate — warn-and-allow (AC3.5)", () => {
  test("a non-tmux session cannot be driven; gives the reason", () => {
    const g = promptGate({});
    expect(g.canSend).toBe(false);
    expect(g.disabledReason).toContain("tmux");
  });

  test("a plain tmux session sends with no warning", () => {
    expect(promptGate({ tmuxSession: "atlas-web" })).toEqual({ canSend: true });
  });

  test("an attached session warns but still allows (collision risk)", () => {
    const g = promptGate({ tmuxSession: "atlas-web", tmuxAttached: true });
    expect(g.canSend).toBe(true);
    expect(g.warning).toMatch(/attached|collide/);
  });

  test("a working session warns (queues) but still allows", () => {
    const g = promptGate({ tmuxSession: "atlas-web", state: "working" });
    expect(g.canSend).toBe(true);
    expect(g.warning).toMatch(/mid-turn|queue/);
  });

  test("attached takes precedence over working in the warning", () => {
    const g = promptGate({ tmuxSession: "atlas-web", tmuxAttached: true, state: "working" });
    expect(g.warning).toMatch(/attached|collide/);
  });
});
