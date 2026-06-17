import { describe, expect, test } from "bun:test";
import { parsePermissionMenu, isValidAnswerKey } from "./menu";

// Fixture mirrors the assumed Claude Code permission dialog (boxed, ❯ cursor).
// NOTE: confirm against a live prompt at review — if the real format differs,
// this fixture and the parser update together, and the loud fallback covers the gap.
const BOXED = `
╭───────────────────────────────────────────────╮
│ Bash command                                  │
│                                               │
│   rm -rf build                                │
│   Remove the build dir                        │
│                                               │
│ Do you want to proceed?                       │
│ ❯ 1. Yes                                      │
│   2. Yes, and don't ask again this session    │
│   3. No, and tell Claude what to do (esc)     │
╰───────────────────────────────────────────────╯
`;

describe("parsePermissionMenu", () => {
  test("extracts the question and the numbered options from a boxed dialog", () => {
    const menu = parsePermissionMenu(BOXED);
    expect(menu).not.toBeNull();
    expect(menu!.prompt).toBe("Do you want to proceed?");
    expect(menu!.options.map((o) => o.key)).toEqual(["1", "2", "3"]);
    expect(menu!.options[0].label).toBe("Yes");
    expect(menu!.options[2].label).toContain("No");
  });

  test("works without box-drawing chrome (plain text)", () => {
    const plain = "Do you want to proceed?\n1. Yes\n2. No";
    const menu = parsePermissionMenu(plain)!;
    expect(menu.options).toHaveLength(2);
    expect(menu.prompt).toBe("Do you want to proceed?");
  });

  test("returns null when there is no menu (ordinary output)", () => {
    expect(parsePermissionMenu("just some text\nrunning tests\nall good")).toBeNull();
    expect(parsePermissionMenu("")).toBeNull();
  });

  test("a single stray numbered line is not a menu", () => {
    expect(parsePermissionMenu("step 1. do the thing\nnothing else")).toBeNull();
  });

  test("incidental numbered list (not starting a sequential run at 1+2) is ignored", () => {
    // a lone '3.' with no 1./2. preceding is not a menu
    expect(parsePermissionMenu("see note 3. for details")).toBeNull();
  });

  test("prefers the later menu when the pane holds a stale one above", () => {
    const two = "Old?\n1. A\n2. B\n...scroll...\nNew question?\n1. Yes\n2. No";
    const menu = parsePermissionMenu(two)!;
    expect(menu.prompt).toBe("New question?");
    expect(menu.options.map((o) => o.label)).toEqual(["Yes", "No"]);
  });
});

describe("isValidAnswerKey", () => {
  test("accepts single digits and Enter; rejects everything else", () => {
    for (const k of ["1", "2", "9", "Enter"]) expect(isValidAnswerKey(k)).toBe(true);
    for (const k of ["0", "10", "C-c", "Escape", "rm", "", "1; rm"])
      expect(isValidAnswerKey(k)).toBe(false);
  });
});
