import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertBinaryExists,
  assertNoHeadless,
  buildSpawnArgv,
  buildResumeArgv,
  CLAUDE_BIN,
  confineSpawnCwd,
  isAllowedModel,
  MODEL_ALLOWLIST,
  sessionName,
} from "./spawn";

const UUID = "11112222-3333-4444-5555-666677778888";

// ── AC3.1 — argv builder + missing-binary assertion ───────────────────────────
describe("AC3.1 argv is execFile-style with an absolute claude path", () => {
  test("the launch is argv (an array), never a shell string", () => {
    const argv = buildSpawnArgv({ uuid: UUID, model: "opus", cwd: "/home/you/x" });
    expect(Array.isArray(argv)).toBe(true);
    // The cwd rides as `-c <dir>` (tmux's cwd flag), never `sh -c "<string>"`:
    // assert no shell binary, and no element packs a shell line.
    expect(argv).not.toContain("sh");
    expect(argv).not.toContain("bash");
    for (const a of argv) expect(a).not.toMatch(/&&|\|\||;/);
  });

  test("claude is referenced by its absolute path", () => {
    const argv = buildSpawnArgv({ uuid: UUID, model: "sonnet", cwd: "/home/you/x" });
    expect(argv).toContain(CLAUDE_BIN);
    expect(CLAUDE_BIN.startsWith("/")).toBe(true);
    // the binary token, not a bare `claude` on PATH
    expect(argv).not.toContain("claude");
  });

  test("assertBinaryExists throws loudly when the resolved binary is missing", () => {
    expect(() => assertBinaryExists("/no/such/claude", () => false)).toThrow(/not found/);
  });

  test("assertBinaryExists passes when the binary exists", () => {
    expect(() => assertBinaryExists(CLAUDE_BIN, () => true)).not.toThrow();
  });
});

// ── AC3.3 — start-fresh pins uuid + model, validated against the allowlist ─────
describe("AC3.3 model allowlist enforcement", () => {
  test("the four pickable aliases are allowlisted", () => {
    expect([...MODEL_ALLOWLIST]).toEqual(["opus", "sonnet", "haiku", "fable"]);
    for (const m of MODEL_ALLOWLIST) expect(isAllowedModel(m)).toBe(true);
  });

  test("an allowlisted model pins --session-id <uuid> --model <m>", () => {
    const argv = buildSpawnArgv({ uuid: UUID, model: "haiku", cwd: "/home/you/x" });
    const i = argv.indexOf("--session-id");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe(UUID);
    const j = argv.indexOf("--model");
    expect(argv[j + 1]).toBe("haiku");
  });

  test("a non-allowlisted model is rejected BEFORE any launch is built", () => {
    expect(() => buildSpawnArgv({ uuid: UUID, model: "gpt-4o", cwd: "/home/you/x" })).toThrow(
      /not on allowlist/,
    );
    expect(() => buildSpawnArgv({ uuid: UUID, model: "opus[1m]", cwd: "/home/you/x" })).toThrow(
      /not on allowlist/,
    );
    expect(isAllowedModel("claude-opus-4-8")).toBe(false);
  });
});

// ── AC3.4 — cwd confined under /home/you; uuid-token session name ──────────────
describe("AC3.4 cwd guard + tmux name shape", () => {
  test("the session name is bifrost-spawn-<uuid8>, never a guessed integer", () => {
    expect(sessionName(UUID)).toBe("bifrost-spawn-11112222");
    expect(sessionName(UUID)).toMatch(/^bifrost-spawn-[0-9a-f]{8}$/);
  });

  test("the built argv carries the uuid-token name to -s", () => {
    const argv = buildSpawnArgv({ uuid: UUID, model: "opus", cwd: "/home/you/x" });
    const i = argv.indexOf("-s");
    expect(argv[i + 1]).toBe("bifrost-spawn-11112222");
  });

  test("a cwd inside the confinement root is admitted", async () => {
    // Exercise the real syscall against a scratch root rather than a real home
    // layout — the security property is realpath's behavior, and the test should
    // not depend on which user is running it.
    const base = realpathSync(await mkdtemp(join(tmpdir(), "bifrost-spawn-")));
    const inside = join(base, "proj");
    await mkdir(inside);
    try {
      const r = await confineSpawnCwd(inside, base);
      expect(r.ok).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a cwd outside the confinement root is rejected", async () => {
    const r = await confineSpawnCwd("/etc");
    expect(r).toEqual({ ok: false, reason: "outside-root" });
  });

  test("a `..` escape out of /home/you is rejected (canonicalized)", async () => {
    // realpath resolves the traversal to /etc, which fails the within-root test.
    const r = await confineSpawnCwd("/home/you/../../etc");
    expect(r.ok).toBe(false);
  });

  test("a nonexistent cwd is not-found, not silently admitted", async () => {
    const r = await confineSpawnCwd("/home/you/__nope_does_not_exist__");
    expect(r).toEqual({ ok: false, reason: "not-found" });
  });
});

// ── AC3.6 — the argv never contains headless / SDK / -p forms ──────────────────
describe("AC3.6 no headless/SDK forms in the launch argv", () => {
  test("the built launch is only tmux new-session … <abs claude> --session-id …", () => {
    const argv = buildSpawnArgv({ uuid: UUID, model: "opus", cwd: "/home/you/x" });
    expect(argv[0]).toBe("tmux");
    expect(argv[1]).toBe("new-session");
    const binIdx = argv.findIndex((a) => a.endsWith("/claude"));
    expect(binIdx).toBeGreaterThan(-1);
    expect(argv[binIdx + 1]).toBe("--session-id");
    // none of the headless/SDK forms appear
    for (const bad of ["-p", "--print", "--headless", "--sdk", "--agent"]) {
      expect(argv).not.toContain(bad);
    }
  });

  test("assertNoHeadless rejects an argv carrying -p", () => {
    expect(() =>
      assertNoHeadless(["tmux", "new-session", "-d", CLAUDE_BIN, "-p", "do it"]),
    ).toThrow(/forbidden/);
  });

  test("assertNoHeadless rejects --print", () => {
    expect(() =>
      assertNoHeadless(["tmux", "new-session", CLAUDE_BIN, "--print"]),
    ).toThrow(/forbidden/);
  });

  test("assertNoHeadless rejects a launch that isn't tmux new-session", () => {
    expect(() => assertNoHeadless([CLAUDE_BIN, "--session-id", UUID])).toThrow(
      /tmux .*new-session/,
    );
  });

  test("assertNoHeadless rejects claude launched without --session-id/--resume", () => {
    expect(() =>
      assertNoHeadless(["tmux", "new-session", "-d", CLAUDE_BIN, "--model", "opus"]),
    ).toThrow(/--session-id or --resume/);
  });

  test("assertNoHeadless accepts a --resume interactive launch", () => {
    expect(() =>
      assertNoHeadless(["tmux", "new-session", "-d", CLAUDE_BIN, "--resume", UUID]),
    ).not.toThrow();
  });
});

// ── spawned panes are sized like a real terminal ────────────────────────────────
describe("spawn pane sizing (TUI chrome needs width)", () => {
  test("both builders size the detached pane (80x24 default truncates the status bar)", () => {
    for (const argv of [
      buildSpawnArgv({ uuid: UUID, model: "opus", cwd: "/home/you/x" }),
      buildResumeArgv({ uuid: UUID, cwd: "/home/you/x" }),
    ]) {
      const x = argv.indexOf("-x");
      const y = argv.indexOf("-y");
      expect(x).toBeGreaterThan(-1);
      expect(y).toBeGreaterThan(-1);
      expect(Number(argv[x + 1])).toBeGreaterThanOrEqual(200);
      expect(Number(argv[y + 1])).toBeGreaterThanOrEqual(40);
    }
  });
});
