import { describe, expect, test } from "bun:test";
import {
  residenceOf,
  modelFamily,
  applyFilters,
  matchesFilters,
  isFiltering,
  NO_FILTERS,
} from "./sessionFilters";
import type { SessionInfo } from "../../../shared/types";

const s = (over: Partial<SessionInfo>): SessionInfo => ({
  sessionId: Math.random().toString(36).slice(2),
  live: true,
  cwd: "/x",
  lastActivityAt: 1000,
  ...over,
});

describe("residenceOf", () => {
  test("most specific wins: tmux over ssh over entrypoint", () => {
    expect(residenceOf(s({ tmuxSession: "w", overSsh: true }))).toBe("tmux");
    expect(residenceOf(s({ overSsh: true, entrypoint: "cli" }))).toBe("ssh");
    expect(residenceOf(s({ entrypoint: "claude-desktop" }))).toBe("desktop");
    expect(residenceOf(s({ entrypoint: "cli" }))).toBe("terminal");
    expect(residenceOf(s({}))).toBe("other");
  });
});

describe("modelFamily", () => {
  test("classifies by id, variant-agnostic", () => {
    expect(modelFamily(s({ model: "claude-fable-5[1m]" }))).toBe("fable");
    expect(modelFamily(s({ model: "claude-opus-4-8" }))).toBe("opus");
    expect(modelFamily(s({ model: "claude-sonnet-4-6" }))).toBe("sonnet");
    expect(modelFamily(s({ model: "claude-haiku-4-5" }))).toBe("haiku");
    expect(modelFamily(s({ model: undefined }))).toBe("other");
  });
});

describe("isFiltering", () => {
  test("false only when every dimension is unset", () => {
    expect(isFiltering(NO_FILTERS)).toBe(false);
    expect(isFiltering({ ...NO_FILTERS, model: "opus" })).toBe(true);
    expect(isFiltering({ ...NO_FILTERS, maxIdleMs: 1000 })).toBe(true);
  });
});

describe("matchesFilters / applyFilters", () => {
  const now = 1_000_000;
  const tmuxFable = s({ tmuxSession: "w", model: "claude-fable-5[1m]", lastActivityAt: now - 1000 });
  const desktopOpus = s({ entrypoint: "claude-desktop", model: "claude-opus-4-8", lastActivityAt: now - 5 * 86_400_000 });
  const sshHaiku = s({ overSsh: true, model: "claude-haiku-4-5", lastActivityAt: now - 2 * 3_600_000 });
  const all = [tmuxFable, desktopOpus, sshHaiku];

  test("no filters passes everything", () => {
    expect(applyFilters(all, NO_FILTERS, now)).toEqual(all);
  });
  test("residence filter", () => {
    expect(applyFilters(all, { ...NO_FILTERS, residence: "tmux" }, now)).toEqual([tmuxFable]);
  });
  test("model filter", () => {
    expect(applyFilters(all, { ...NO_FILTERS, model: "opus" }, now)).toEqual([desktopOpus]);
  });
  test("idle cutoff hides sessions older than the threshold", () => {
    // < 1d hides the 5-day-idle desktop session
    expect(applyFilters(all, { ...NO_FILTERS, maxIdleMs: 86_400_000 }, now)).toEqual([
      tmuxFable,
      sshHaiku,
    ]);
  });
  test("dimensions compose (AND)", () => {
    expect(
      matchesFilters(tmuxFable, { residence: "tmux", model: "fable", maxIdleMs: 86_400_000 }, now),
    ).toBe(true);
    expect(
      matchesFilters(tmuxFable, { residence: "tmux", model: "opus", maxIdleMs: null }, now),
    ).toBe(false);
  });
});
