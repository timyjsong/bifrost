import { describe, expect, test } from "bun:test";
import { parseTranscript } from "./transcript";

// Fixtures mirror the real transcript shape (verified against this repo's own
// transcript): assistant turns are one JSONL line per content block sharing
// message.id; user entries are a string prompt or a tool_result array.
const L = (o: unknown) => JSON.stringify(o);

describe("parseTranscript", () => {
  test("groups consecutive assistant block-lines (same message.id) into one ordered turn", () => {
    const lines = [
      L({ type: "user", uuid: "u1", message: { role: "user", content: "hi there" } }),
      L({ type: "assistant", uuid: "a1", message: { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } }),
      L({ type: "assistant", uuid: "a2", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "hello" }] } }),
      L({ type: "assistant", uuid: "a3", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } }),
    ];
    const { messages } = parseTranscript(lines, "s1");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const turn = messages[1];
    expect(turn.blocks.map((b) => b.kind)).toEqual(["thinking", "text", "tool_use"]);
    expect(turn.blocks[2]).toMatchObject({ kind: "tool_use", id: "t1", name: "Bash" });
    expect(messages[0].blocks[0]).toEqual({ kind: "text", text: "hi there" });
  });

  test("a new message.id starts a new assistant turn", () => {
    const lines = [
      L({ type: "assistant", uuid: "a1", message: { id: "m1", content: [{ type: "text", text: "one" }] } }),
      L({ type: "assistant", uuid: "a2", message: { id: "m2", content: [{ type: "text", text: "two" }] } }),
    ];
    const { messages } = parseTranscript(lines, "s1");
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => (m.blocks[0] as { text: string }).text)).toEqual(["one", "two"]);
  });

  test("drops isMeta user lines (injected reminders / command noise)", () => {
    const lines = [
      L({ type: "user", uuid: "u1", isMeta: true, message: { content: "<system-reminder>noise</system-reminder>" } }),
      L({ type: "user", uuid: "u2", message: { content: "real prompt" } }),
    ];
    const { messages } = parseTranscript(lines, "s1");
    expect(messages).toHaveLength(1);
    expect(messages[0].uuid).toBe("u2");
  });

  test("parses tool_result (array content) and links it to its tool_use", () => {
    const lines = [
      L({ type: "user", uuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ls output", is_error: false }] } }),
    ];
    const { messages } = parseTranscript(lines, "s1");
    expect(messages[0].blocks[0]).toEqual({ kind: "tool_result", forId: "t1", text: "ls output", isError: false });
  });

  test("tool_result with structured text content joins the text parts; is_error rides through", () => {
    const lines = [
      L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "boom" }], is_error: true }] } }),
    ];
    const b = parseTranscript(lines, "s1").messages[0].blocks[0];
    expect(b).toEqual({ kind: "tool_result", forId: "t2", text: "boom", isError: true });
  });

  test("preserves sidechain (subagent) topology — not flattened away", () => {
    const lines = [
      L({ type: "assistant", uuid: "a1", isSidechain: true, message: { id: "m1", content: [{ type: "text", text: "subagent" }] } }),
      L({ type: "assistant", uuid: "a2", isSidechain: false, message: { id: "m2", content: [{ type: "text", text: "main" }] } }),
    ];
    const { messages } = parseTranscript(lines, "s1");
    expect(messages.map((m) => m.isSidechain)).toEqual([true, false]);
  });

  test("skips blank lines, unparseable lines, and empty-content turns", () => {
    const lines = [
      "",
      "{not json",
      L({ type: "assistant", message: { id: "m1", content: [] } }),
      L({ type: "mode", mode: "plan" }),
      L({ type: "user", message: { content: "kept" } }),
    ];
    const { messages } = parseTranscript(lines, "s1");
    expect(messages).toHaveLength(1);
    expect(messages[0].blocks[0]).toEqual({ kind: "text", text: "kept" });
  });
});
