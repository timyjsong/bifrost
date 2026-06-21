import { describe, expect, test } from "bun:test";
import { resolveKey, stopAction } from "./keymap";

describe("resolveKey — the chat keymap (Build 1 review)", () => {
  test("plain enter is a newline (compose multi-line)", () => {
    expect(resolveKey({ key: "Enter" })).toBe("newline");
  });

  test("shift+enter is still a newline", () => {
    expect(resolveKey({ key: "Enter", shiftKey: true })).toBe("newline");
  });

  test("ctrl+enter submits", () => {
    expect(resolveKey({ key: "Enter", ctrlKey: true })).toBe("submit");
  });

  test("cmd+enter submits (mac)", () => {
    expect(resolveKey({ key: "Enter", metaKey: true })).toBe("submit");
  });

  test("alt+enter is stop", () => {
    expect(resolveKey({ key: "Enter", altKey: true })).toBe("stop");
  });

  test("ctrl/cmd wins over alt when both are held", () => {
    expect(resolveKey({ key: "Enter", ctrlKey: true, altKey: true })).toBe("submit");
  });

  test("escape closes the chat (draft preserved by the caller)", () => {
    expect(resolveKey({ key: "Escape" })).toBe("close");
  });

  test("native editing chords return null (never preventDefaulted)", () => {
    expect(resolveKey({ key: "c", ctrlKey: true })).toBeNull(); // copy
    expect(resolveKey({ key: "v", ctrlKey: true })).toBeNull(); // paste
    expect(resolveKey({ key: "a", ctrlKey: true })).toBeNull(); // select-all
    expect(resolveKey({ key: "a" })).toBeNull(); // ordinary typing
  });
});

describe("stopAction — the dual meaning of stop", () => {
  test("a parked send is cancelled", () => {
    expect(stopAction("pending")).toBe("cancel");
  });

  test("a running turn is interrupted", () => {
    expect(stopAction("working")).toBe("interrupt");
  });

  test("idle has nothing to stop", () => {
    expect(stopAction("idle")).toBeNull();
  });
});
