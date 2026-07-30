/**
 * The declared vocabulary the leak guard checks against: the accepted
 * placeholder values, the invented project names fixtures may use, and the
 * invented session ids they may use.
 *
 * Unlike `patterns.ts`, this file IS scanned like every other file. It holds
 * values, and values are exactly what the guard exists to check — that is the
 * whole point of the split. The unscannable surface is regexes and nothing else.
 *
 * Both lists are POSITIVE allowlists, and both are cross-checked against the
 * machine: `placeholders.test.ts` asserts that no declared project name is a
 * real directory and no declared session id names a real session. Without that,
 * an allowlist certifies itself — and one of these did, for a while, contain a
 * real directory name.
 */


/** The accepted placeholder values, spelled once. */
export const PLACEHOLDER = {
  home: "/home/you",
  homeSlug: "-home-you-",
  tailnet: "your-tailnet",
  cgnat: "100.100.100.100",
  emailDomain: "@example.com",
  noreplyDomain: "@users.noreply.github.com",
} as const;


/**
 * The segment a project name would occupy in a home-rooted path — the slug form
 * flattens sub-paths into dashes, so the two spellings split differently.
 *
 * Lives here rather than in the test because it has to spell the placeholder
 * literals, and the test is scanned: a literal there would be flagged by the
 * very check it feeds.
 */
export function projectSegment(path: string): string | null {
  const rest = path.startsWith(PLACEHOLDER.homeSlug)
    ? path.slice(PLACEHOLDER.homeSlug.length).split("/")[0].split("-")
    : path.replace(new RegExp(`^${PLACEHOLDER.home}/?`), "").split("/");
  const segs = rest.filter(Boolean);
  if (!segs.length) return null;
  return CONTAINERS.has(segs[0].toLowerCase()) ? (segs[1] ?? null) : segs[0];
}

/**
 * Directory names too ordinary to be evidence of anything.
 *
 * A machine can have a folder named after a common English word, and flagging
 * every prose use of it makes the guard unrunnable — which is worse than a gap,
 * because an unrunnable guard gets deleted. Distinctive names are what leak.
 */
export const COMMON_WORDS = new Set([
  "mobile", "desktop", "server", "client", "shared", "common", "public",
  "private", "static", "assets", "images", "scripts", "styles", "config",
  "notes", "drafts", "backup", "temp", "tools", "utils", "vendor",
  "docs", "data", "test", "tests", "build", "dist", "sandbox", "scratch",
  
]);

/** Path segments that hold projects rather than being one. */
export const CONTAINERS = new Set(["projects", "code", "work", "src", "tmp", "data"]);

/**
 * Every project name any fixture is allowed to use. Adding an entry must be a
 * deliberate "yes, I invented this" — that is the whole control. Checked on CI
 * and on a dev box identically, which the directory-scan check cannot be.
 */
export const DEMO_PROJECTS = new Set([
  "atlas", "atlas-web", "ledger", "ledger-api", "vector", "vector-lab",
  "bifrost", "proj", "myproj", "project", "app", "demo",
  "gone", "old", "secrets", "contraband", "other",
  "__nope_does_not_exist__", "my", "my.proj",
  "a", "b", "c", "d", "e", "k", "p", "x", "y", "one", "two", "alpha", "beta",
]);

/**
 * Every session id any fixture is allowed to use, spelled out.
 *
 * An explicit allowlist, not a heuristic. The previous version accepted any id
 * containing a run of three identical hex digits, on the reasoning that a random
 * v4 id "essentially never" does — which is wrong by two orders of magnitude.
 * Measured against the real session ids on the machine this guards, that rule
 * admitted 12% of them. A session id is opaque and cannot be judged by shape, so
 * the only sound control is naming the ones that are invented.
 */
export const FIXTURE_UUIDS = new Set([
  "00000000-0000-0000-0000-000000000001",
  "11112222-3333-4444-5555-666677778888",
  "12340000-0000-4000-8000-000000000001",
  "12340000-0000-4000-8000-000000000002",
  "12340000-0000-4000-8000-000000000003",
  "12340000-0000-4000-8000-000000000004",
  "1a2b3c4d-1111-2222-3333-444455556666",
  "aaaa0000-0000-4000-8000-000000000001",
  "aaaa0000-0000-4000-8000-000000000002",
  "aaaa1111-0000-0000-0000-000000000000",
  "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "aaaabbbb-1111-2222-3333-444455556666",
  "bbbb0000-0000-4000-8000-000000000001",
  "bbbb0000-0000-4000-8000-000000000002",
  "bbbb0000-0000-4000-8000-000000000003",
  "bbbb0000-1111-2222-3333-444455556666",
  "bbbb2222-0000-0000-0000-000000000000",
  "cccc0000-0000-4000-8000-000000000001",
  "cccc0000-0000-4000-8000-000000000002",
  "cccc0000-1111-2222-3333-444455556666",
  "cccc7777-1111-2222-3333-888899990000",
  "dddd0000-1111-2222-3333-444455556666",
  "eeee0000-0000-4000-8000-000000000001",
  "eeee0000-0000-4000-8000-000000000002",
  "eeee0000-1111-2222-3333-444455556666",
  "ffff0000-0000-4000-8000-000000000001",
  "ffff0000-1111-2222-3333-444455556666",
  "ffff9999-0000-1111-2222-333344445555",
  "ffffffff-1111-2222-3333-444444444444",
]);
