import { describe, expect, test } from "bun:test";
import { parseEffortSlider, effortIndexByValue } from "./effort";

// Fixtures captured LIVE from the /effort slider (Claude Code v2.1.198,
// 2026-07-02) — column positions preserved exactly; the parser is geometric.
const PAD = " ".repeat(79);
const SLIDER_XHIGH = [
  "   Effort",
  `${PAD}Faster                                                 Smarter`,
  `${PAD}──────────────────────────────▲────────────┆──────────────────`,
  `${PAD}low     medium     high     xhigh      max       ultracode`,
  `${" ".repeat(124)}xhigh + workflows`,
  "   ←/→ to adjust · Enter to confirm · Esc to cancel",
].join("\n");

const SLIDER_MAX = [
  "   Effort",
  `${PAD}Faster                                                 Smarter`,
  `${PAD}────────────────────────────────────────▲──┆──────────────────`,
  `${PAD}low     medium     high     xhigh      max       ultracode`,
  `${" ".repeat(124)}xhigh + workflows`,
  "                       May use excessive tokens resulting in long response times or overthinking.",
  "   ←/→ to adjust · Enter to confirm · Esc to cancel",
].join("\n");

describe("parseEffortSlider — the /effort slider contract", () => {
  test("reads the stop labels and the ▲ position (xhigh)", () => {
    const s = parseEffortSlider(SLIDER_XHIGH);
    expect(s).not.toBeNull();
    expect(s!.options).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"]);
    expect(s!.options[s!.currentIndex]).toBe("xhigh");
  });

  test("▲ at another stop reads correctly despite the warning line (max)", () => {
    const s = parseEffortSlider(SLIDER_MAX)!;
    expect(s.options[s.currentIndex]).toBe("max");
  });

  test("the ┆ zone separator and the sub-caption are not stops", () => {
    const s = parseEffortSlider(SLIDER_XHIGH)!;
    expect(s.options).not.toContain("┆");
    expect(s.options.join(" ")).not.toContain("workflows");
  });

  test("a clipped slider (footer scrolled off — small window) returns null, never a guess", () => {
    const clipped = SLIDER_XHIGH.split("\n").slice(0, -1).join("\n");
    expect(parseEffortSlider(clipped)).toBeNull();
  });

  test("a pane without the slider returns null", () => {
    expect(parseEffortSlider("❯ hello\n● hi\n  ← for agents")).toBeNull();
  });
});

describe("effortIndexByValue — resolve a peeked stop against a fresh parse", () => {
  const stops = ["low", "medium", "high", "xhigh", "ultracode"];
  test("finds the stop by label", () => {
    expect(effortIndexByValue(stops, "high")).toBe(2);
    expect(effortIndexByValue(stops, "low")).toBe(0);
  });
  test("a stop no longer offered returns -1", () => {
    expect(effortIndexByValue(stops, "insane")).toBe(-1);
  });
});
