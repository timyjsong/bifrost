/**
 * Read-only directory listing. Runs ONLY on a path already cleared by
 * confinePath. Uses lstat (no symlink follow) so a symlink shows as what it is;
 * if the user navigates into one, that new path re-runs through confinePath, so
 * an escaping symlink is rejected at click time, never here. No writes, ever.
 */
import { readdir, lstat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";
import type { FileEntry } from "../../shared/types";

// Hidden by default — every project would otherwise drown in these.
const HIDDEN_DIRS = new Set([".git", "node_modules"]);

function classify(st: Stats): FileEntry["type"] {
  if (st.isSymbolicLink()) return "symlink";
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  return "other";
}

/**
 * List `dir`'s entries: dirs first, then everything alphabetically. Hides
 * `.git` / `node_modules` unless `all`. Throws if `dir` isn't a readable
 * directory (the caller maps that to a 4xx).
 */
export async function listDir(dir: string, all: boolean): Promise<FileEntry[]> {
  const names = await readdir(dir);
  const out: FileEntry[] = [];
  for (const name of names) {
    if (!all && HIDDEN_DIRS.has(name)) continue;
    let st: Stats;
    try {
      st = await lstat(join(dir, name));
    } catch {
      continue; // vanished between readdir and lstat — skip it
    }
    out.push({ name, type: classify(st), size: st.size, mtimeMs: st.mtimeMs });
  }
  out.sort((a, b) => {
    const ad = a.type === "dir";
    const bd = b.type === "dir";
    if (ad !== bd) return ad ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}
