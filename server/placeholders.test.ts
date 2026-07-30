/**
 * Repo-wide guard against publishing a real machine's identifiers.
 *
 * This exists because the narrower version failed. `config.test.ts` checks the
 * shipped config template and only that, so when a port from the private tree
 * overwrote two lines of `tasknames.test.ts` with real values — a real
 * username, a real home path, a private project name — nothing caught it. The
 * scrub that missed it was grepping for `/home/<user>` and the leak was in the
 * slug form, `-home-<user>-`. A guard that only knows one spelling is not a
 * guard.
 *
 * So this scans every tracked text file for the SHAPES an identifier takes,
 * and requires each to be the documented placeholder:
 *
 *   home paths      /home/you        (and the slug form, -home-you-)
 *   tailnet hosts   *your-tailnet*.ts.net
 *   tailscale IPs   100.100.100.100
 *   e-mail          @example.com
 *
 * It asserts by SHAPE rather than by a denylist of known-bad values, for the
 * same reason `config.test.ts` does: a denylist only ever catches the machine it
 * was written on, and writing the real values into a public test to check for
 * them would leak exactly what it is meant to prevent.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

/** Every tracked file git knows about, minus the binary ones. */
async function trackedTextFiles(): Promise<string[]> {
  const proc = Bun.spawn(["git", "-C", repoRoot, "ls-files", "-z"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out
    .split("\0")
    .filter(Boolean)
    .filter((f) => !/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|lock)$/i.test(f));
}

const files = await trackedTextFiles();
const read = (f: string) => Bun.file(join(repoRoot, f)).text();

/** Where a match lives, so a failure names the file and line, not just the value. */
async function scan(pattern: RegExp): Promise<string[]> {
  const hits: string[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = await read(f);
    } catch {
      continue; // unreadable or binary — nothing to leak from here
    }
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(pattern)) hits.push(`${f}:${i + 1}  ${m[0]}`);
    });
  }
  return hits;
}

describe("no real machine identifiers are published", () => {
  test("git ls-files returned something — the scan is not vacuously passing", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test("every absolute home path is the placeholder user", async () => {
    const hits = await scan(/\/home\/[A-Za-z0-9._-]+/g);
    expect(hits.filter((h) => !h.endsWith("/home/you"))).toEqual([]);
  });

  // The form that actually got through: Claude Code slugifies a cwd by replacing
  // separators with dashes, so /home/you/x becomes -home-you-x and a scrub
  // looking for slashes sails straight past it.
  test("every slugified home path is the placeholder user", async () => {
    const hits = await scan(/-home-[A-Za-z0-9._-]+?-/g);
    expect(hits.filter((h) => !h.endsWith("-home-you-"))).toEqual([]);
  });

  test("every tailnet host announces itself as a placeholder", async () => {
    const hits = await scan(/[A-Za-z0-9._-]+\.ts\.net/g);
    expect(hits.filter((h) => !h.includes("your-tailnet"))).toEqual([]);
  });

  // Tailscale hands out CGNAT addresses; any that appear must be the documented
  // example one. Other RFC-reserved/loopback literals are fine.
  test("every tailscale-range address is the documented placeholder", async () => {
    const hits = await scan(/\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g);
    expect(hits.filter((h) => !h.endsWith("100.100.100.100"))).toEqual([]);
  });

  test("every e-mail address sits in the RFC 2606 reserved domain", async () => {
    // Skip the co-author trailer form and package metadata by matching only
    // things shaped like a real address in prose or code.
    const hits = await scan(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g);
    const bad = hits.filter(
      (h) => !/@example\.com$/.test(h) && !/@users\.noreply\.github\.com$/.test(h),
    );
    expect(bad).toEqual([]);
  });
});
