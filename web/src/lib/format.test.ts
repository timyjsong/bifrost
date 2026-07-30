import { describe, expect, test } from "bun:test";
import {
  relTime,
  fmtTokens,
  fmtKb,
  fmtBytes,
  fmtUptime,
  basename,
  tildify,
  clip,
} from "./format";

const NOW = Date.parse("2026-06-11T12:00:00Z");

describe("relTime", () => {
  test("buckets", () => {
    expect(relTime(NOW - 10_000, NOW)).toBe("now");
    expect(relTime(NOW - 5 * 60_000, NOW)).toBe("5m");
    expect(relTime(NOW - 3 * 3_600_000, NOW)).toBe("3h");
    expect(relTime(NOW - 4 * 86_400_000, NOW)).toBe("4d");
    expect(relTime(undefined, NOW)).toBe("—");
  });
  test("very old falls back to a date", () => {
    expect(relTime(NOW - 30 * 86_400_000, NOW)).toMatch(/May/);
  });
});

describe("fmtTokens", () => {
  test("K and M scaling", () => {
    expect(fmtTokens(950)).toBe("950");
    expect(fmtTokens(117_443)).toBe("117K");
    expect(fmtTokens(1_250_000)).toBe("1.25M");
    expect(fmtTokens(undefined)).toBe("—");
  });
});

describe("fmtKb / fmtUptime", () => {
  test("kb scaling", () => {
    expect(fmtKb(512)).toBe("512K");
    expect(fmtKb(2048)).toBe("2M");
    expect(fmtKb(2 * 1024 * 1024)).toBe("2.0G");
  });
  test("uptime", () => {
    expect(fmtUptime(5 * 86400 + 4 * 3600)).toBe("5d 4h");
    expect(fmtUptime(2 * 3600 + 30 * 60)).toBe("2h 30m");
  });
});

describe("fmtBytes", () => {
  test("B / K / M / G scaling", () => {
    expect(fmtBytes(0)).toBe("0B");
    expect(fmtBytes(512)).toBe("512B");
    expect(fmtBytes(1536)).toBe("1.5K");
    expect(fmtBytes(5 * 1024 * 1024)).toBe("5.0M");
    expect(fmtBytes(3 * 1024 ** 3)).toBe("3.0G");
  });
});

describe("paths", () => {
  test("basename and tildify", () => {
    expect(basename("/home/you/projects/ledger-api")).toBe("ledger-api");
    expect(tildify("/home/you/projects/ledger-api")).toBe("~/projects/ledger-api");
  });
});

describe("clip", () => {
  test("leaves anything within budget untouched", () => {
    expect(clip("short", 10)).toBe("short");
    expect(clip("exactly10!", 10)).toBe("exactly10!");
  });

  test("never exceeds the budget — the ellipsis is paid for out of it", () => {
    const out = clip("abcdefghijk", 5);
    expect(out).toBe("abcd…");
    expect(out.length).toBe(5);
  });
});
