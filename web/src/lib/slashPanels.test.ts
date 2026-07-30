import { describe, expect, test } from "bun:test";
import { classifySlash, slashTag } from "./slashPanels";

describe("classifySlash — panel commands can't be driven from chat", () => {
  test("control commands (Bifrost has a UI control) point at the control", () => {
    expect(classifySlash("/model")?.kind).toBe("control");
    expect(classifySlash("/effort")?.kind).toBe("control");
    expect(classifySlash("/rewind")?.kind).toBe("control");
    expect(classifySlash("/model")?.hint).toContain("model pill");
  });

  test("panel-openers (verified live to block on a picker) route to the raw terminal", () => {
    for (const cmd of ["/config", "/status", "/mcp", "/cost", "/help", "/memory"]) {
      const c = classifySlash(cmd);
      expect(c?.kind).toBe("panel");
      expect(c?.hint).toContain(cmd); // hint names the command
      expect(c?.hint).toContain("raw terminal");
    }
  });

  test("session-ending / auth commands are refused as danger", () => {
    expect(classifySlash("/exit")?.kind).toBe("danger");
    expect(classifySlash("/logout")?.kind).toBe("danger");
    expect(classifySlash("/login")?.kind).toBe("danger");
    expect(classifySlash("/exit")?.hint).toContain("restart");
  });

  test("safe streaming / one-shot commands pass through (null) — verified idle-return", () => {
    // /context and /agents returned to idle in the live probe; /clear /compact
    // stream to the transcript.
    for (const cmd of ["/context", "/agents", "/clear", "/compact", "/init", "/review"]) {
      expect(classifySlash(cmd)).toBeNull();
    }
  });

  test("classification is case-insensitive and trims", () => {
    expect(classifySlash("/MODEL")?.kind).toBe("control");
    expect(classifySlash("  /Config  ")?.kind).toBe("panel");
  });
});

describe("slashTag — suggester annotation", () => {
  test("each class maps to a short tag; unclassified → null", () => {
    expect(slashTag("/model")).toBe("in-app");
    expect(slashTag("/config")).toBe("raw only");
    expect(slashTag("/exit")).toBe("blocked");
    expect(slashTag("/clear")).toBeNull();
  });
});
