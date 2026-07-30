/**
 * Pure name search over the session list (story 2-1, AC1.6).
 *
 * Case-insensitive substring match on a session's name (the user-set title else
 * the cwd basename), ranked so prefix matches sort ahead of mid-string matches.
 * No I/O — it runs over the already-loaded snapshot, so a search box can call it
 * per keystroke for free. Names search is over the FULL list the caller passes;
 * the caller (not this matcher) owns whether that list is the uncapped index.
 */
/** The minimal shape the matcher needs — a custom title and/or a cwd. Satisfied
 *  by both `SessionInfo` (the rendered list) and `SessionIndexEntry` (the
 *  uncapped search index), so search runs over either without a cast. */
export interface Named {
  customTitle?: string;
  cwd?: string;
}

/** The searchable name for a row: the user-set title, else the cwd basename. */
export function sessionName(s: Named): string {
  if (s.customTitle && s.customTitle.trim()) return s.customTitle;
  const cwd = s.cwd ?? "";
  const trimmed = cwd.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

/** Match rank: 0 = prefix hit, 1 = other substring hit, -1 = no match. */
export function matchRank(name: string, queryLower: string): number {
  const n = name.toLowerCase();
  const at = n.indexOf(queryLower);
  if (at < 0) return -1;
  return at === 0 ? 0 : 1;
}

/**
 * Filter `sessions` to those whose name contains `query` (case-insensitive),
 * prefix matches first, preserving the input order within each rank tier (a
 * stable sort over the original order). A blank query returns the list
 * unchanged. Zero I/O.
 */
export function searchByName<T extends Named>(
  sessions: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  const hits: { s: T; rank: number; ord: number }[] = [];
  sessions.forEach((s, ord) => {
    const rank = matchRank(sessionName(s), q);
    if (rank >= 0) hits.push({ s, rank, ord });
  });
  hits.sort((a, b) => a.rank - b.rank || a.ord - b.ord);
  return hits.map((h) => h.s);
}
