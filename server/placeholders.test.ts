/**
 * Repo-wide guard against publishing a real machine's identifiers.
 *
 * It exists because narrower versions kept failing, each in a way worth keeping
 * written down:
 *
 *  - `config.test.ts` checked the shipped config template and only that, so a
 *    port that overwrote two fixture lines with real values sailed past.
 *  - The hand-scrub that missed those was grepping the slash form while the leak
 *    was in the slug form. A guard that knows one spelling is not a guard.
 *  - Shape checks cannot see a NAME. Real project directories were published
 *    with only the username swapped, and no pattern over a path can tell an
 *    invented project from a real one.
 *  - A heuristic cannot see a session id either. The version that accepted "any
 *    id containing a run of three identical hex digits" admitted 12% of the real
 *    session ids on this machine, including ones from client work.
 *  - This file used to exempt itself from its own scan. Twice, that exclusion
 *    hid the exact leak spelling it had been written to catch.
 *
 * So: the patterns and the declared vocabulary live in `testing/identifiers.ts`,
 * which is the only unscanned file, and this test is scanned like everything
 * else. Names and session ids are POSITIVE allowlists — invented values are
 * enumerable, real ones are not.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import {
  CGNAT,
  CONCAT_HOME,
  DEMO_PROJECTS,
  EMAIL,
  FIXTURE_UUIDS,
  HOME_PATH,
  HOME_ROOTED,
  HOME_SLUG,
  PLACEHOLDER,
  projectSegment,
  ROOTED_PATH,
  STRING_LITERAL,
  TAILNET,
  UUID,
} from "./testing/identifiers";

const repoRoot = join(import.meta.dir, "..");

/** The one file the scan cannot read: it is made of the patterns it matches. */
const PATTERNS_MODULE = "server/testing/identifiers.ts";

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
const scannable = files.filter((f) => f !== PATTERNS_MODULE);
const read = (f: string) => Bun.file(join(repoRoot, f)).text();

/** Where a match lives, so a failure names the file and line, not just the value. */
async function scan(pattern: RegExp): Promise<string[]> {
  const hits: string[] = [];
  for (const f of scannable) {
    let text: string;
    try {
      text = await read(f);
    } catch {
      continue;
    }
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(pattern)) hits.push(`${f}:${i + 1}  ${m[0]}`);
    });
  }
  return hits;
}

/** Directory names under the developer's real work and project roots. */
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

const realNames = localProjectNames()
  .filter((n) => n.length >= 4 && !["bifrost", "web", "src", "code"].includes(n))
  .map((n) => n.toLowerCase());

function skipNotice(): void {
  console.warn(
    "[placeholders] reality checks SKIPPED: no developer project roots on this host. " +
      "The shape and allowlist checks still ran and carry the guarantee here; these two " +
      "only add protection when the suite runs on the machine the fixtures could leak from.",
  );
}

describe("shape: no real machine identifiers", () => {
  test("git ls-files returned something — the scan is not vacuously passing", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test("the patterns module is the ONLY unscanned file", () => {
    expect(files.filter((f) => !scannable.includes(f))).toEqual([PATTERNS_MODULE]);
  });

  test("every absolute home path is the placeholder user", async () => {
    const hits = await scan(HOME_PATH);
    expect(hits.filter((h) => !h.toLowerCase().endsWith(PLACEHOLDER.home))).toEqual([]);
  });

  test("every slugified home path is the placeholder user", async () => {
    const hits = await scan(HOME_SLUG);
    expect(hits.filter((h) => !h.toLowerCase().endsWith(PLACEHOLDER.homeSlug))).toEqual([]);
  });

  test("every tailnet host announces itself as a placeholder", async () => {
    const hits = await scan(TAILNET);
    expect(hits.filter((h) => !h.includes(PLACEHOLDER.tailnet))).toEqual([]);
  });

  test("every tailscale-range address is the documented placeholder", async () => {
    const hits = await scan(CGNAT);
    expect(hits.filter((h) => !h.endsWith(PLACEHOLDER.cgnat))).toEqual([]);
  });

  test("every e-mail address sits in the RFC 2606 reserved domain", async () => {
    const hits = await scan(EMAIL);
    const bad = hits.filter(
      (h) => !h.endsWith(PLACEHOLDER.emailDomain) && !h.endsWith(PLACEHOLDER.noreplyDomain),
    );
    expect(bad).toEqual([]);
  });

  test("no source assembles a home path out of fragments", async () => {
    expect(await scan(CONCAT_HOME)).toEqual([]);
  });
});

// Positive allowlists. Invented values are a finite, enumerable set; real ones
// are not, so the guard names what is allowed rather than guessing what is not.
describe("allowlist: fixtures use declared values only", () => {
  test("fixture project names come from the demo vocabulary", async () => {
    const hits = await scan(HOME_ROOTED);
    const offenders = new Set<string>();
    for (const hit of hits) {
      const value = hit.slice(hit.indexOf("  ") + 2);
      const seg = projectSegment(value);
      if (!seg) continue;
      const name = seg.toLowerCase().replace(/\.[a-z0-9]+$/, "");
      if (/^[0-9a-f]{6,}$/.test(name) || /^\d+$/.test(name)) continue;
      if (seg.startsWith(".") || seg === "..") continue;
      if (DEMO_PROJECTS.has(name)) continue;
      if ([...DEMO_PROJECTS].some((d) => d.length > 2 && name.startsWith(d + "-"))) continue;
      offenders.add(`${hit}  (project: ${seg})`);
    }
    expect([...offenders]).toEqual([]);
  });

  // The class the heuristic version let through. A session id is opaque, so the
  // only sound control is enumerating the invented ones.
  test("every session uuid is a declared fixture id", async () => {
    const hits = await scan(UUID);
    const bad = hits.filter(
      (h) => !FIXTURE_UUIDS.has(h.slice(h.lastIndexOf(" ") + 1).toLowerCase()),
    );
    expect(bad).toEqual([]);
  });

  // Enforces the claim that the unscanned patterns module holds no VALUES —
  // checked on its string literals, not its regex sources, which necessarily
  // look like what they match.
  test("the patterns module carries patterns and vocabulary, never a value", async () => {
    const raw = await read(PATTERNS_MODULE);
    const literals = [...raw.matchAll(/"([^"\\\n]*)"/g)].map((m) => m[1]);
    const suspicious = literals.filter(
      (l) =>
        (/\/home\//i.test(l) && l !== PLACEHOLDER.home) ||
        (/[-_]home[-_]/i.test(l) && l !== PLACEHOLDER.homeSlug) ||
        (/\.ts\.net/i.test(l) && !l.includes(PLACEHOLDER.tailnet)) ||
        (/\b100\.\d/.test(l) && l !== PLACEHOLDER.cgnat),
    );
    expect(suspicious).toEqual([]);
    const uuids = [...raw.matchAll(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi)];
    expect(uuids.map((m) => m[0]).filter((u) => !FIXTURE_UUIDS.has(u))).toEqual([]);
  });
});

// Reality: the only check that can tell an invented name from a real one. It
// needs the machine to compare against, so it cannot run on a CI runner — the
// allowlists above are what carry the guarantee there.
describe("reality: fixtures do not name anything on this machine", () => {
  test("no fixture PATH segment names a real directory", async () => {
    if (!realNames.length) return skipNotice();
    const hits = await scan(ROOTED_PATH);
    const offenders: string[] = [];
    for (const hit of hits) {
      const value = hit
        .slice(hit.indexOf("  ") + 2)
        .toLowerCase()
        .replace(/\/[^/]*\.[a-z0-9]+$/, "/");
      for (const name of realNames) {
        const re = new RegExp(
          `(?:^|[/_-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[/_.-])`,
        );
        if (re.test(value)) offenders.push(`${hit}  (real directory: ${name})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The class that left a real project name behind as a bare search term after
  // an earlier scrub rewrote the path but not the string next to it. A name in
  // a quoted string is just as real as one in a path.
  test("no bare string literal is a real directory name", async () => {
    if (!realNames.length) return skipNotice();
    const hits = await scan(STRING_LITERAL);
    const offenders: string[] = [];
    for (const hit of hits) {
      const raw = hit.slice(hit.indexOf("  ") + 2).replace(/^["'`]|["'`]$/g, "");
      const words = raw.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
      for (const name of realNames) {
        if (words.includes(name)) offenders.push(`${hit}  (real directory: ${name})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
