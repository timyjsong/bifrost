import { describe, expect, test } from "bun:test";
import { promptGate, filterSlash } from "./drive";
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
