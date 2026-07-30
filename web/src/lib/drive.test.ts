import { describe, expect, test } from "bun:test";
import {
  promptGate,
  filterSlash,
  reconcileDraft,
  sendFailureMessage,
  sendOutcome,
  diffLineKind,
  interceptComposer,
  menuFailureMessage,
} from "./drive";
import type { SlashCommand } from "../../../shared/types";

const CMDS: SlashCommand[] = [
  { name: "/clear", source: "builtin" },
  { name: "/compact", source: "builtin" },
  { name: "/model", source: "builtin" },
  { name: "/ledger-api-flow", source: "skill" },
];

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

  test("the working state is not a gate concern — no warning (UI disables instead)", () => {
    expect(promptGate({ tmuxSession: "atlas-web" })).toEqual({ canSend: true });
  });
});

describe("filterSlash — the suggester (AC7)", () => {
  test("suggests on '/' + prefix; prefix matches first, alphabetical", () => {
    expect(filterSlash("/c", CMDS).map((c) => c.name)).toEqual(["/clear", "/compact"]);
  });

  test("a bare '/' suggests everything (capped)", () => {
    expect(filterSlash("/", CMDS)).toHaveLength(4);
  });

  test("substring (non-prefix) still matches, ranked after prefixes", () => {
    expect(filterSlash("/pact", CMDS).map((c) => c.name)).toEqual(["/compact"]);
  });

  test("does NOT suggest once there's a space (args being typed) — never gates", () => {
    expect(filterSlash("/clear ", CMDS)).toEqual([]);
    expect(filterSlash("/model sonnet", CMDS)).toEqual([]);
  });

  test("does not suggest for non-slash input", () => {
    expect(filterSlash("hello", CMDS)).toEqual([]);
    expect(filterSlash("", CMDS)).toEqual([]);
  });
});

describe("reconcileDraft — live cross-device sync", () => {
  test("a remote edit (differs from baseline + box) is adopted", () => {
    // typed on the desktop; this device's box/baseline still hold the old value
    const r = reconcileDraft({ local: "old", lastSynced: "old", remote: "from desktop" });
    expect(r).toEqual({ adopt: true, value: "from desktop", baseline: "from desktop" });
  });

  test("no remote change (remote === baseline) keeps un-saved local keystrokes", () => {
    // user is mid-type: box ahead of the server, but the server hasn't changed
    const r = reconcileDraft({ local: "hello wor", lastSynced: "hello", remote: "hello" });
    expect(r.adopt).toBe(false);
    expect(r.value).toBe("hello wor");
    expect(r.baseline).toBe("hello"); // baseline unmoved — no remote edit happened
  });

  test("remote already equals the box: don't touch it, just advance the baseline", () => {
    // our own debounced save landed; the poll now sees it
    const r = reconcileDraft({ local: "synced", lastSynced: "older", remote: "synced" });
    expect(r.adopt).toBe(false);
    expect(r.baseline).toBe("synced");
  });

  test("a remote clear (send fired elsewhere) clears this device's box", () => {
    const r = reconcileDraft({ local: "draft", lastSynced: "draft", remote: "" });
    expect(r).toEqual({ adopt: true, value: "", baseline: "" });
  });

  test("steady state (all three equal) is a no-op", () => {
    expect(reconcileDraft({ local: "x", lastSynced: "x", remote: "x" })).toEqual({
      adopt: false,
      value: "x",
      baseline: "x",
    });
  });

  // M1 (cycle 21): the failed-PUT race. When a draft PUT fails the baseline is
  // NOT advanced (saveDraft returns false), so the server still holds the OLD
  // value and lastSynced still equals it — reconcile must then NOT adopt that
  // stale remote over the user's newer local text.
  test("a failed PUT leaves baseline == stale remote → newer local text is kept", () => {
    // user typed "new text" locally; PUT failed so baseline stayed "old" and the
    // server still returns "old" on the next receive poll
    const r = reconcileDraft({ local: "new text", lastSynced: "old", remote: "old" });
    expect(r.adopt).toBe(false);
    expect(r.value).toBe("new text");
  });
});

describe("sendFailureMessage — fire-time failure → composer strip line", () => {
  test("a gone/non-injectable session names the cause and promises the restore", () => {
    for (const reason of ["session-gone", "not-injectable"]) {
      const m = sendFailureMessage(reason);
      expect(m).toContain("wasn't running");
      expect(m).toContain("kept in the draft");
    }
  });

  test("an injection error is distinct but also promises the restore", () => {
    const m = sendFailureMessage("send-error");
    expect(m).toContain("couldn't be injected");
    expect(m).toContain("kept in the draft");
  });

  test("an unknown reason still yields a usable line", () => {
    expect(sendFailureMessage("??").length).toBeGreaterThan(10);
  });
});

describe("sendOutcome — how the submit UI reads a schedulePrompt result", () => {
  test("an accepted park is 'parked'", () => {
    expect(sendOutcome({ ok: true, delayMs: 3000 })).toBe("parked");
  });
  test("a server refusal (HTTP status) is 'rejected' — safe to restore text", () => {
    expect(sendOutcome({ ok: false, reason: "http 409" })).toBe("rejected");
  });
  test("a network throw is 'indeterminate' — must NOT restore text (may have parked)", () => {
    expect(sendOutcome({ ok: false, indeterminate: true, reason: "Failed to fetch" })).toBe(
      "indeterminate",
    );
  });
});

describe("diffLineKind — unified diff render rule", () => {
  test("classifies adds, dels, hunks, meta, context", () => {
    expect(diffLineKind("+new line")).toBe("add");
    expect(diffLineKind("-old line")).toBe("del");
    expect(diffLineKind("@@ -1,3 +1,4 @@")).toBe("hunk");
    expect(diffLineKind("+++ b/file.ts")).toBe("meta");
    expect(diffLineKind("--- a/file.ts")).toBe("meta");
    expect(diffLineKind("diff --git a/x b/x")).toBe("meta");
    expect(diffLineKind(" unchanged")).toBe("ctx");
  });
});

describe("interceptComposer — panel-opening commands never reach the TUI", () => {
  test("/model, /effort, /rewind — alone or with arguments — are intercepted with a hint", () => {
    expect(interceptComposer("/model")).not.toBeNull();
    expect(interceptComposer("/model opus")).not.toBeNull();
    expect(interceptComposer("  /model  ")).not.toBeNull();
    expect(interceptComposer("/effort")).not.toBeNull();
    expect(interceptComposer("/effort max")).not.toBeNull();
    expect(interceptComposer("/rewind")).not.toBeNull();
    expect(interceptComposer("/MODEL")).not.toBeNull(); // case-insensitive
  });

  test("each hint points at the in-app control", () => {
    expect(interceptComposer("/model")).toContain("model pill");
    expect(interceptComposer("/effort")).toContain("effort pill");
    expect(interceptComposer("/rewind")).toContain("rewind button");
  });

  test("panel-openers with no control (config/mcp/…) and session-enders (exit) are also intercepted", () => {
    expect(interceptComposer("/config")).toContain("raw terminal");
    expect(interceptComposer("/mcp")).toContain("raw terminal");
    expect(interceptComposer("/exit")).toContain("restart");
  });

  test("ordinary text and safe streaming slash commands pass through", () => {
    expect(interceptComposer("hello")).toBeNull();
    expect(interceptComposer("/models are neat")).toBeNull();
    expect(interceptComposer("/modelling clay")).toBeNull();
    expect(interceptComposer("/clear")).toBeNull();
    expect(interceptComposer("/compact")).toBeNull();
    expect(interceptComposer("/context")).toBeNull();
    expect(interceptComposer("tell me about /model")).toBeNull();
  });
});

describe("menuFailureMessage — picker-open failure copy", () => {
  test("attached-small explains the fixable cause", () => {
    const m = menuFailureMessage("attached-small", "rewind menu");
    expect(m).toContain("terminal is attached");
    expect(m).toContain("rewind menu");
  });

  test("anything else falls back to the version-drift message", () => {
    const m = menuFailureMessage("menu-unreadable", "model menu");
    expect(m).toContain("version may have changed");
  });
});
