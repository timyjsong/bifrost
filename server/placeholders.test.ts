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
 *   home paths      the placeholder user, in both slash and slug form
 *   tailnet hosts   a host naming itself a placeholder, under .ts.net
 *   tailscale IPs   the documented example address in the CGNAT range
 *   e-mail          the RFC 2606 reserved domain
 *
 * The accepted values are spelled out in the assertions below rather than here,
 * because this file is one of the files it scans — see the slug test.
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
    .filter((f) => !/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|lock)$/i.test(f))
    // This file is definitionally full of identifier-shaped text — the patterns
    // it matches with are themselves matches. Scanning itself flagged its own
    // documentation once and its own regex source once, so it is excluded and
    // carries no fixtures of its own to make that exclusion cost anything.
    .filter((f) => f !== "server/placeholders.test.ts");
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

  // The form that actually got through: Claude Code slugifies a working
  // directory by replacing every path separator with a dash, so the home prefix
  // survives with no slashes left in it — and a scrub written to look for
  // slashes sails straight past. Deliberately described rather than shown: an
  // example here would be a literal identifier in a file this test scans.
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

  // Shape checks cannot catch a NAME. The first leak here was caught by shape —
  // a real username — but the same fixtures also carried four of this machine's
  // actual project directory names with only the username swapped, and no
  // pattern over a path can tell an invented project from a real one.
  //
  // So the PROJECT-NAME POSITION specifically is checked against a declared
  // vocabulary: the segment straight after the home root, or after a container
  // directory like projects/ or work/. Filenames, ids and extensions further
  // down the path are not project names and are left alone — the earlier
  // attempt checked every token and drowned in `.jpeg` and hex ids.
  const CONTAINERS = new Set(["projects", "code", "work", "src", "tmp", "data"]);
  const DEMO_PROJECTS = new Set([
    "atlas", "atlas-web", "ledger", "ledger-api", "vector", "vector-lab",
    "bifrost", "proj", "myproj", "project", "app",
    "gone", "old", "secrets", "contraband",
    // names invented for specific fixtures — each one added here should be a
    // deliberate "yes, I made this up", which is the whole point of the list
    "other", "demo-trader", "__nope_does_not_exist__", "my", "my.proj",
    "a", "b", "c", "d", "e", "k", "p", "x", "y", "one", "two", "alpha", "beta",
  ]);

  /** The segment a project name would occupy, given a home-rooted path. */
  function projectSegment(path: string): string | null {
    const rest = path.startsWith("-home-you-")
      ? path.slice("-home-you-".length).split("/")[0].split("-")
      : path.replace(/^\/home\/you\/?/, "").split("/");
    const segs = rest.filter(Boolean);
    if (!segs.length) return null;
    return CONTAINERS.has(segs[0].toLowerCase()) ? (segs[1] ?? null) : segs[0];
  }

  test("fixture project names come from the demo vocabulary, not this machine", async () => {
    const hits = await scan(/(?:\/home\/you|-home-you)[A-Za-z0-9._/-]*/g);
    const offenders = new Set<string>();
    for (const hit of hits) {
      const value = hit.slice(hit.indexOf("  ") + 2);
      const seg = projectSegment(value);
      if (!seg) continue;
      const name = seg.toLowerCase().replace(/\.[a-z0-9]+$/, "");
      if (/^[0-9a-f]{6,}$/.test(name) || /^\d+$/.test(name)) continue;
      if (seg.startsWith(".") || seg === "..") continue; // dotdirs, traversal probes
      // A slug flattens sub-paths into dashes, so accept any leading run that
      // is itself a declared name (work-atlas-web -> atlas-web).
      if (DEMO_PROJECTS.has(name)) continue;
      if ([...DEMO_PROJECTS].some((d) => name === d || name.startsWith(d + "-"))) continue;
      offenders.add(`${hit}  (project: ${seg})`);
    }
    expect([...offenders]).toEqual([]);
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
