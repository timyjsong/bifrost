/**
 * Path confinement — the load-bearing security boundary for the read-only file
 * browser. A requested path is admitted ONLY if its canonical (symlink- and
 * `..`-resolved) form lives inside one of the known project roots. realpath does
 * the work: a `..` escape or a symlink pointing at `~/.claude.json` both resolve
 * to a real path that fails the within-root test, so neither can leak.
 *
 * Pure where it can be (`isWithinRoot`); the canonicalizer takes an injectable
 * realpath so the contract is testable, but production and the tests both run it
 * against the real filesystem — the security property IS the syscall behavior.
 */
import { realpath as realpathFs } from "node:fs/promises";
import { sep } from "node:path";

/**
 * Is `child` the same path as `root`, or genuinely nested under it? Both must be
 * absolute, already-canonical paths. The trailing-separator guard closes the
 * prefix trap: `/home/you/projects/atrium-secrets` must NOT count as inside
 * `/home/you/projects/atrium`.
 */
export function isWithinRoot(child: string, root: string): boolean {
  if (child === root) return true;
  const base = root.endsWith(sep) ? root : root + sep;
  return child.startsWith(base);
}

export type ConfineResult =
  | { ok: true; path: string }
  | { ok: false; reason: "outside-root" | "not-found" };

/**
 * Canonicalize `requested` (resolving every symlink and `..` in the whole path)
 * and require the result to live inside one of `roots`. Roots are canonicalized
 * too, so a symlinked realm compares correctly. A path that doesn't resolve at
 * all is `not-found`; one that resolves outside every root is `outside-root`.
 */
export async function confinePath(
  requested: string,
  roots: string[],
  realpath: (p: string) => Promise<string> = realpathFs,
): Promise<ConfineResult> {
  let canonical: string;
  try {
    canonical = await realpath(requested);
  } catch {
    return { ok: false, reason: "not-found" };
  }
  for (const root of roots) {
    let canonRoot: string;
    try {
      canonRoot = await realpath(root);
    } catch {
      continue; // a root that doesn't resolve can't contain anything
    }
    if (isWithinRoot(canonical, canonRoot)) return { ok: true, path: canonical };
  }
  return { ok: false, reason: "outside-root" };
}
