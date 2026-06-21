import { describe, expect, test } from "bun:test";
import { promptGate, filterSlash, reconcileDraft } from "./drive";
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
});
