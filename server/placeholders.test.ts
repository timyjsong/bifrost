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
import { homedir } from "node:os";
import { existsSync, readdirSync } from "node:fs";

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
    .filter((f) => !/\.(png|jpe?g|gif|webp|ico|woff2?|ttf)$/i.test(f));
}

const files = await trackedTextFiles();
/** This file self-matches on its own regex source, so pattern scans skip it —
 *  but ONLY those. The allowlist below is what makes that exclusion safe. */
const SELF = "server/placeholders.test.ts";
const scannable = files.filter((f) => f !== SELF);
const read = (f: string) => Bun.file(join(repoRoot, f)).text();

/** Where a match lives, so a failure names the file and line, not just the value. */
async function scan(pattern: RegExp): Promise<string[]> {
  const hits: string[] = [];
  for (const f of scannable) {
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

// The check that would actually have caught the leak that got out: compare
// fixture names against the directories that exist on THIS machine. Shape and
// vocabulary checks are both blind to a real project name — only reality is
// not. Skipped where the directories do not exist (CI), which is honest: there
// is nothing to leak from a machine that has none of them.
describe("fixtures do not name a real directory on this machine", () => {
  /** Directory names under the developer's real work/project roots. */
  function localProjectNames(): string[] {
    const roots = ["work", "projects", "code", "src"].map((d) => join(homedir(), d));
    const names: string[] = [];
    for (const r of roots) {
      if (!existsSync(r)) continue;
      try {
        for (const e of readdirSync(r, { withFileTypes: true })) {
          if (e.isDirectory() && !e.name.startsWith(".")) names.push(e.name);
        }
      } catch {
        /* unreadable root */
      }
    }
    return names;
  }

  // Scoped to PATH POSITIONS, not prose: a machine can have a directory called
  // something that is also an ordinary English word, and flagging every prose
  // use of it would make this unrunnable. The leak vector is a real name inside
  // a fixture path or slug, so that is exactly what is compared.
  test("no fixture path segment names a directory from this machine's roots", async () => {
    const local = new Set(
      localProjectNames()
        .filter((n) => n.length >= 4 && !["bifrost", "web", "src", "code"].includes(n))
        .map((n) => n.toLowerCase()),
    );
    // On a CI runner none of those roots exist, so this check has nothing to
    // compare against and passes vacuously. That is correct — there is nothing
    // to leak from a machine with no projects on it — but a green badge must
    // not be read as evidence this ran. It says so out loud instead.
    if (!local.size) {
      console.warn(
        "[placeholders] reality check SKIPPED: no developer project roots on this host. " +
          "The shape and vocabulary checks still ran; this one only protects when the " +
          "suite runs on the machine the fixtures could have leaked from.",
      );
      return;
    }

    // Any rooted path, not just the placeholder home: a real directory name is
    // equally real under /srv, /opt or a tilde. Root-agnostic because what is
    // being checked is the NAME, and the name does not care where it is rooted.
    const hits = await scan(/(?:~|\/[A-Za-z0-9._-]+|[-_]home[-_]you)[A-Za-z0-9._/-]*/gi);
    const offenders: string[] = [];
    for (const hit of hits) {
      // Drop a trailing filename: "docs/<name>.png" is a file, and a file that
      // happens to begin with a real directory's name is not a leak.
      const value = hit
        .slice(hit.indexOf("  ") + 2)
        .toLowerCase()
        .replace(/\/[^/]*\.[a-z0-9]+$/, "/");
      for (const name of local) {
        // Boundary-delimited substring, not a split on "-": a hyphenated name
        // like "<word>-<word>" never survives splitting into segments, which is
        // exactly the shape the real leak had.
        const re = new RegExp(`(?:^|[/_-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[/_.-])`);
        if (re.test(value)) offenders.push(`${hit}  (real directory: ${name})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("no real machine identifiers are published", () => {
  test("git ls-files returned something — the scan is not vacuously passing", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test("every absolute home path is the placeholder user", async () => {
    const hits = await scan(/\/home\/[A-Za-z0-9._-]+/gi);
    expect(hits.filter((h) => !h.toLowerCase().endsWith("/home/you"))).toEqual([]);
  });

  // The form that actually got through: Claude Code slugifies a working
  // directory by replacing every path separator with a dash, so the home prefix
  // survives with no slashes left in it — and a scrub written to look for
  // slashes sails straight past. Deliberately described rather than shown: an
  // example here would be a literal identifier in a file this test scans.
  test("every slugified home path is the placeholder user", async () => {
    // Case-insensitive, and both separators: the slug form is produced by
    // replacing path separators, and which character does the replacing is an
    // implementation detail no scrub should depend on.
    const hits = await scan(/[-_]home[-_][A-Za-z0-9._-]+?[-_]/gi);
    const ok = (h: string) => /[-_]home[-_]you[-_]$/i.test(h);
    expect(hits.filter((h) => !ok(h))).toEqual([]);
  });

  // A path assembled from fragments defeats every pattern above, because no
  // single literal in the source contains it. Cheap to check, and it is the
  // obvious way to smuggle one past a scanner that only reads literals.
  test("no source concatenates a home path out of fragments", async () => {
    const hits = await scan(/"\/home\/?"\s*\+|"[-_]home[-_]"\s*\+|\+\s*"\/home/gi);
    expect(hits).toEqual([]);
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
    // NOTE: single-letter entries below are throwaway fixture names. They are
    // deliberately NOT usable as a prefix (see the exact-match check), because
    // "a-<realname>" would otherwise launder a real name past this list.
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
      // Prefix acceptance only for multi-character declared names — a single
      // letter prefixing a real name ("a-acme-client") must not pass.
      if ([...DEMO_PROJECTS].some((d) => d.length > 2 && name.startsWith(d + "-"))) continue;
      offenders.add(`${hit}  (project: ${seg})`);
    }
    expect([...offenders]).toEqual([]);
  });

  // The class that actually got through the LAST scrub. A session id is opaque,
  // so no shape check can tell a real one from an invented one — but the repo
  // only ever needs invented ones, so the shapes it uses are declarable. A real
  // Claude Code session id is random hex and will not match.
  //
  // This is the same positive-allowlist logic as the project-name check, and it
  // exists because the previous scrub rewrote the DIRECTORY on a fixture line
  // and left the session id sitting inside the same string.
  test("every session uuid is a declared synthetic fixture, not a real id", async () => {
    const hits = await scan(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    );
    const bad = hits.filter((h) => {
      const hex = h.slice(h.lastIndexOf(" ") + 1).toLowerCase().replace(/-/g, "");
      // Every fixture in this repo is hand-typed from repeated characters
      // ("aaaa", "1111", "ffff"). A random v4 id essentially never contains a
      // run of three identical hex digits, so requiring one separates them
      // without needing to know any real value. Character VARIETY does not
      // work here — "1a2b3c4d-1111-…" is synthetic and has plenty of it.
      return !/(.)\1{2,}/.test(hex);
    });
    expect(bad).toEqual([]);
  });

  // Belt for the self-exclusion above: the scanner skips its own source, so the
  // claim "it carries no fixtures" has to be enforced rather than asserted in a
  // comment. Anything identifier-shaped in this file must be a pattern, not a
  // value — checked by requiring the literal placeholder tokens and nothing else.
  test("the guard's own source carries no identifier-shaped literals", async () => {
    // Only double-quoted string literals. The regexes in this file necessarily
    // LOOK like the values they match, which is the whole reason the scanner
    // skips this file — so re-scanning its raw source would fail on its own
    // patterns and teach nothing.
    const raw = await read(SELF);
    const self = [...raw.matchAll(/"([^"\\]*)"/g)].map((m) => m[1]).join("\n");
    const paths = [...self.matchAll(/\/home\/[A-Za-z0-9._-]+/g)].map((m) => m[0]);
    expect(paths.filter((p) => p !== "/home/you")).toEqual([]);
    const ips = [...self.matchAll(/\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g)].map((m) => m[0]);
    expect(ips.filter((i) => i !== "100.100.100.100")).toEqual([]);
    const hosts = [...self.matchAll(/[A-Za-z0-9._-]+\.ts\.net/g)].map((m) => m[0]);
    expect(hosts.filter((h) => !h.includes("your-tailnet"))).toEqual([]);
    const uuids = [...self.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)];
    expect(uuids.map((m) => m[0])).toEqual([]);
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
