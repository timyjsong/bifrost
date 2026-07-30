/**
 * Split a unified `git diff HEAD` blob into per-file sections so the review
 * panel can show a file list + collapsible per-file diffs (the mobile app's
 * diff-view shape), instead of one flat wall. Pure — the diff string already
 * carries `diff --git a/… b/…` headers; no extra server round-trip.
 */

export interface FileDiff {
  /** Display path (the b-side / new path; a-side for a pure deletion). */
  path: string;
  /** rename → "old → new"; else same as path. */
  label: string;
  status: "modified" | "added" | "deleted" | "renamed" | "binary";
  added: number; // '+' body lines
  removed: number; // '-' body lines
  /** The section's lines (header through last hunk line), as rendered. */
  lines: string[];
}

const GIT_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;

/** Best-effort path from a `+++ b/…` or `--- a/…` line (strips the a//b/ prefix
 *  and handles /dev/null). Returns null if it isn't a path line. */
function sidePath(line: string): string | null {
  const m = /^(?:\+\+\+|---) (?:[ab]\/)?(.*)$/.exec(line);
  if (!m) return null;
  const p = m[1].trim();
  return p === "/dev/null" ? null : p;
}

export function splitDiffByFile(diff: string): FileDiff[] {
  if (!diff.trim()) return [];
  const lines = diff.split("\n");
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;

  const flush = () => {
    if (cur) files.push(cur);
    cur = null;
  };

  for (const line of lines) {
    const gh = GIT_HEADER.exec(line);
    if (gh) {
      flush();
      const [, aPath, bPath] = gh;
      cur = {
        path: bPath,
        label: aPath === bPath ? bPath : `${aPath} → ${bPath}`,
        status: aPath === bPath ? "modified" : "renamed",
        added: 0,
        removed: 0,
        lines: [line],
      };
      continue;
    }
    if (!cur) continue; // preamble before the first file header (none, normally)
    cur.lines.push(line);

    if (line.startsWith("new file")) cur.status = "added";
    else if (line.startsWith("deleted file")) cur.status = "deleted";
    else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch"))
      cur.status = "binary";

    // Count body lines only (skip the +++/--- file markers).
    if (line.startsWith("+") && !line.startsWith("+++")) cur.added++;
    else if (line.startsWith("-") && !line.startsWith("---")) cur.removed++;

    // A rename that also has body changes still shows its new path; a pure
    // add/delete gets its path from the surviving side.
    if (cur.status === "added") {
      const p = line.startsWith("+++") && sidePath(line);
      if (p) {
        cur.path = p;
        cur.label = p;
      }
    } else if (cur.status === "deleted") {
      const p = line.startsWith("---") && sidePath(line);
      if (p) {
        cur.path = p;
        cur.label = p;
      }
    }
  }
  flush();
  return files;
}
