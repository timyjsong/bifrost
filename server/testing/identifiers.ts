/**
 * The declared vocabulary the leak guard checks against.
 *
 * This is the ONE file `placeholders.test.ts` cannot scan, because it is made of
 * patterns that necessarily look like the values they match. Everything else in
 * the repo — including the test itself — is scanned. Keeping the unscannable
 * surface to a single small, purely declarative module is the point: the
 * previous design excluded the whole test file, and that exclusion twice turned
 * out to hide exactly the leak spelling it was written for.
 *
 * Nothing here may be a VALUE. Patterns, and lists of invented names, only.
 * `placeholders.test.ts` asserts that separately, on this file's string
 * literals, so the rule is enforced rather than stated.
 */

/** Absolute home paths. */
export const HOME_PATH = /\/home\/[A-Za-z0-9._-]+/gi;
/** The slugified form: separators replaced, so no slashes survive. */
export const HOME_SLUG = /[-_]home[-_][A-Za-z0-9._-]+?[-_]/gi;
/** Tailnet hosts. */
export const TAILNET = /[A-Za-z0-9._-]+\.ts\.net/gi;
/** Tailscale CGNAT addresses. */
export const CGNAT = /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
/** Anything shaped like an e-mail address. */
export const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
/** Session ids. */
export const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** A path rooted anywhere, for the name checks. */
export const ROOTED_PATH = /(?:~|\/[A-Za-z0-9._-]+|[-_]home[-_]you)[A-Za-z0-9._/-]*/gi;
/** Any quoted string literal, for the bare-name check. */
export const STRING_LITERAL = /["'`]([^"'`\\\n]{2,60})["'`]/g;
/** A home path assembled from fragments, which defeats every literal scan. */
export const CONCAT_HOME = /["'`]\/?home\/?["'`]\s*\+|\+\s*["'`]\/?home|\$\{[^}]*\}\/home|\/home\/\$\{/gi;

/** The accepted placeholder values, spelled once. */
export const PLACEHOLDER = {
  home: "/home/you",
  homeSlug: "-home-you-",
  tailnet: "your-tailnet",
  cgnat: "100.100.100.100",
  emailDomain: "@example.com",
  noreplyDomain: "@users.noreply.github.com",
} as const;

/** Home-rooted paths in either spelling, for the project-name check. */
export const HOME_ROOTED = /(?:\/home\/you|-home-you)[A-Za-z0-9._/-]*/g;

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
  "gone", "old", "secrets", "contraband", "other", "demo-trader",
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
