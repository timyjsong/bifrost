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
  COMMON_WORDS,
  DEMO_PROJECTS,
  FIXTURE_UUIDS,
  PLACEHOLDER,
  projectSegment,
} from "./testing/identifiers";
import {
  CGNAT,
  CONCAT_HOME,
  EMAIL,
  HOME_PATH,
  HOME_ROOTED,
  HOME_SLUG,
  ROOTED_PATH,
  TAILNET,
  UUID,
  WORD_TOKEN,
} from "./testing/patterns";

const repoRoot = join(import.meta.dir, "..");

/** The one file the scan cannot read: it is regexes, which look like matches. */
const PATTERNS_MODULE = "server/testing/patterns.ts";

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

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf)$/i;

/** Every tracked file, binaries included — the extension filter comes later. */
async function allTrackedFiles(): Promise<string[]> {
  const proc = Bun.spawn(["git", "-C", repoRoot, "ls-files", "-z"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split("\0").filter(Boolean);
}

/** Every commit message in the repo — the channel a tree scan cannot see. */
async function allCommitMessages(): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repoRoot, "log", "--all", "--format=%B%n%an%n%ae"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
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
    } catch (err) {
      // Loudly, not silently: an unreadable tracked file is a file this guard
      // cannot vouch for, and the earlier version just skipped it.
      throw new Error(`placeholders: cannot read tracked file ${f} — ${String(err)}`);
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
  .map((n) => n.toLowerCase())
  .filter((n) => n.length >= 4 && n !== "bifrost" && !COMMON_WORDS.has(n));

const flat = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Does this token name a real directory?
 *
 * Exact match on the separator-stripped form, so a hyphenated name is caught in
 * its CamelCase and underscored spellings too — OR a boundary-delimited
 * occurrence inside a longer token, so a name embedded in a path is caught.
 *
 * Deliberately NOT a plain substring test: a short real name would then match
 * inside ordinary English words, which floods the check with noise and gets it
 * deleted. Both halves were found by running it, not by reasoning about it.
 */
function matchesRealName(token: string): string | null {
  const f = flat(token);
  const lower = token.toLowerCase();
  for (const name of realNames) {
    if (f === flat(name)) return name;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|[^a-z0-9])${esc}(?:$|[^a-z0-9])`).test(lower)) return name;
  }
  return null;
}

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

  // Computed against EVERY tracked file, not the extension-filtered list — the
  // earlier version compared the filtered list against itself and could not fail.
  test("the patterns module is the only text file exempt from the scan", async () => {
    const all = await allTrackedFiles();
    const text = all.filter((f) => !BINARY_EXT.test(f));
    expect(text.filter((f) => !scannable.includes(f))).toEqual([PATTERNS_MODULE]);
  });

  // Binary files are excluded from the text scan, so they are checked directly
  // rather than trusted. A PNG comment chunk is a real place to hide a string.
  test("no binary carries embedded text that could hold an identifier", async () => {
    const all = await allTrackedFiles();
    const offenders: string[] = [];
    for (const f of all.filter((x) => BINARY_EXT.test(x))) {
      const buf = new Uint8Array(await Bun.file(join(repoRoot, f)).arrayBuffer());
      const ascii = Array.from(buf, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "\u0000")).join("");
      for (const chunk of ["tEXt", "iTXt", "zTXt", "eXIf", "Comment"]) {
        if (ascii.includes(chunk)) offenders.push(`${f}  (${chunk} chunk)`);
      }
      for (const m of ascii.matchAll(/\/home\/[A-Za-z0-9._-]+/g)) offenders.push(`${f}  ${m[0]}`);
    }
    expect(offenders).toEqual([]);
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

  // The exclusion is safe only because the excluded file cannot hold a value.
  // Rather than asserting that in a comment, this pins the file's GRAMMAR: every
  // substantive line is a regex export. A literal has nowhere to live.
  test("the unscanned module contains regex declarations and nothing else", async () => {
    const raw = await read(PATTERNS_MODULE);
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const lines = stripped.split("\n").map((l) => l.trim()).filter(Boolean);
    const bad = lines.filter((l) => !/^export const [A-Z_0-9]+ = \/.*\/[gimsuy]*;$/.test(l));
    expect(bad).toEqual([]);
  });
});

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
  // Any text, not just quoted literals: a real name is equally real in a comment
  // or in prose, and the quoted-only version missed exactly that channel.
  // Compared with separators stripped, so a hyphenated name, its CamelCase form
  // and its underscored form are all recognised as the same name.
  test("no text anywhere names a real directory", async () => {
    if (!realNames.length) return skipNotice();
    const hits = await scan(WORD_TOKEN);
    const offenders: string[] = [];
    for (const hit of hits) {
      const raw = hit.slice(hit.indexOf("  ") + 2);
      const name = matchesRealName(raw);
      if (name) offenders.push(`${hit}  (real directory: ${name})`);
    }
    expect(offenders).toEqual([]);
  });

  // Both allowlists are self-certifying without this: the uuid check validates
  // ids against the set, and the vocabulary check validates names against the
  // set, so poisoning either is invisible to the thing it feeds. These are the
  // reality cross-checks that make adding an entry a claim that can be false.
  test("no declared fixture uuid names a real session on this machine", async () => {
    const projects = join(homedir(), ".claude", "projects");
    if (!existsSync(projects)) return skipNotice();
    const real = new Set<string>();
    for (const slug of readdirSync(projects)) {
      try {
        for (const f of readdirSync(join(projects, slug))) {
          const m = f.match(/^([0-9a-f-]{36})\.jsonl$/i);
          if (m) real.add(m[1].toLowerCase());
        }
      } catch {
        /* unreadable slug dir */
      }
    }
    expect([...FIXTURE_UUIDS].filter((u) => real.has(u))).toEqual([]);
  });

  test("no declared demo project name is a real directory on this machine", () => {
    expect([...DEMO_PROJECTS].filter((d) => realNames.includes(d))).toEqual([]);
  });

  // The channel the tree scan structurally cannot see — and the one a real leak
  // actually used: a commit message naming a client project.
  test("no commit message or author field names a real directory", async () => {
    if (!realNames.length) return skipNotice();
    const text = await allCommitMessages();
    const offenders: string[] = [];
    text.split("\n").forEach((line) => {
      for (const tok of line.match(WORD_TOKEN) ?? []) {
        const name = matchesRealName(tok);
        if (name) offenders.push(`commit message: "${tok}" names ${name}`);
      }
    });
    expect([...new Set(offenders)]).toEqual([]);
  });

  test("no commit message carries a machine identifier", async () => {
    const text = await allCommitMessages();
    for (const pat of [HOME_PATH, HOME_SLUG, TAILNET, CGNAT]) {
      const bad = [...text.matchAll(pat)].map((m) => m[0]);
      const ok = bad.filter(
        (v) =>
          v.toLowerCase() !== PLACEHOLDER.home &&
          v.toLowerCase() !== PLACEHOLDER.homeSlug &&
          !v.includes(PLACEHOLDER.tailnet) &&
          v !== PLACEHOLDER.cgnat,
      );
      expect(ok).toEqual([]);
    }
  });
});
