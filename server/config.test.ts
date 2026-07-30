import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, userSlicePath } from "./config";

const BASE = {
  bind: { host: "127.0.0.1", port: 1 },
  realms: [],
  claudeDir: "~/.claude",
  refresh: { fastMs: 1, slowMs: 1 },
  sessions: { historyDays: 1, maxHistory: 1 },
  summarize: {
    claudeBin: "/opt/claude",
    model: "sonnet",
    effort: "low",
    fastStartArgs: [],
    scratchDir: "~/x",
    cacheDir: "~/y",
    perJobMb: 1,
    ramShare: 0.1,
    memReservePct: 0.1,
    maxInFlightCap: 1,
    maxQueue: 1,
    timeoutMs: 1,
  },
  auth: { origins: [], hosts: [], enrollUrl: "" },
};

function withConfig(overrides: Record<string, unknown>): ReturnType<typeof loadConfig> {
  const dir = mkdtempSync(join(tmpdir(), "bifrost-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ ...BASE, ...overrides }));
  process.env.BIFROST_CONFIG = path;
  return loadConfig();
}

afterEach(() => {
  delete process.env.BIFROST_CONFIG;
});

// ── portability normalization (sub-goal D) ─────────────────────────────────────
describe("loadConfig — spawn/alerts portability defaults", () => {
  test("claudeBin falls back to summarize.claudeBin when omitted", () => {
    expect(withConfig({}).claudeBin).toBe("/opt/claude");
  });

  test("an explicit top-level claudeBin wins and ~ expands", () => {
    expect(withConfig({ claudeBin: "~/bin/claude" }).claudeBin).toBe(
      join(homedir(), "bin/claude"),
    );
  });

  test("alerts default neutral: nothing watched, no limits pair, placeholder subject", () => {
    const cfg = withConfig({});
    expect(cfg.alerts).toEqual({
      watchedUnits: [],
      limitsUnit: null,
      vapidSubject: "mailto:admin@example.com",
    });
  });

  test("configured alert knobs pass through", () => {
    const cfg = withConfig({
      alerts: { watchedUnits: ["ssh"], limitsUnit: "safeguard-rearm", vapidSubject: "mailto:a@b.c" },
    });
    expect(cfg.alerts.watchedUnits).toEqual(["ssh"]);
    expect(cfg.alerts.limitsUnit).toBe("safeguard-rearm");
    expect(cfg.alerts.vapidSubject).toBe("mailto:a@b.c");
  });
});

describe("userSlicePath — uid-derived cgroup slice, never hardcoded", () => {
  test("builds the slice path from the given uid", () => {
    expect(userSlicePath(1000)).toBe("/sys/fs/cgroup/user.slice/user-1000.slice");
    expect(userSlicePath(1234)).toBe("/sys/fs/cgroup/user.slice/user-1234.slice");
  });

  test("defaults to the running process's uid", () => {
    const uid = process.getuid?.() ?? 1000;
    expect(userSlicePath()).toBe(`/sys/fs/cgroup/user.slice/user-${uid}.slice`);
  });
});

describe("loadConfig — lifecycle defaults (idle-park ships disarmed)", () => {
  test("omitted lifecycle → disarmed, 24h window, kill cap 2", () => {
    expect(withConfig({}).lifecycle).toEqual({
      enabled: false,
      idleParkMs: 24 * 3_600_000,
      maxKillsPerSweep: 2,
    });
  });

  test("configured lifecycle passes through", () => {
    expect(
      withConfig({ lifecycle: { enabled: true, idleParkMs: 60_000, maxKillsPerSweep: 1 } })
        .lifecycle,
    ).toEqual({ enabled: true, idleParkMs: 60_000, maxKillsPerSweep: 1 });
  });
});

// The shipped template must stay a VALID, loadable config (so a required new
// field can't silently rot it) and must never carry box-specific secrets.
describe("bifrost.config.example.json — the shipped template", () => {
  const path = join(import.meta.dir, "..", "bifrost.config.example.json");

  test("loads and normalizes without throwing (structurally complete)", () => {
    process.env.BIFROST_CONFIG = path;
    const c = loadConfig();
    expect(c.bind.port).toBeGreaterThan(0);
    expect(c.realms.length).toBeGreaterThan(0);
    expect(c.auth.origins.length).toBeGreaterThan(0);
  });

  // The failure mode this guards: someone regenerates the template from their
  // real bifrost.config.json and commits it. It asserts the SHAPE of a neutral
  // template rather than a denylist of specific values — a denylist only catches
  // the one machine it was written on, and spelling those values out in a public
  // test would leak exactly what the template is supposed to keep out.
  test("carries only placeholder hosts, emails, and paths", () => {
    const raw = readFileSync(path, "utf8");

    // Tailscale CGNAT range — any 100.x must be the documented placeholder.
    for (const ip of raw.match(/\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? []) {
      expect(ip).toBe("100.100.100.100");
    }
    // Any tailnet host must announce itself as a placeholder.
    for (const host of raw.match(/[\w-]+(?:\.[\w-]+)*\.ts\.net/g) ?? []) {
      expect(host).toContain("your-tailnet");
    }
    // Any address must sit in the RFC 2606 reserved domain.
    for (const email of raw.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? []) {
      expect(email.endsWith("@example.com")).toBe(true);
    }
    // Any absolute home path must be the placeholder user.
    for (const home of raw.match(/\/home\/[\w.-]+/g) ?? []) {
      expect(home).toBe("/home/you");
    }
  });
});
