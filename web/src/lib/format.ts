export function relTime(epochMs: number | undefined, now: number): string {
  if (!epochMs) return "—";
  const s = Math.max(0, Math.floor((now - epochMs) / 1000));
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)}d`;
  return new Date(epochMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function fmtTokens(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export function fmtKb(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)}G`;
  if (kb >= 1024) return `${Math.round(kb / 1024)}M`;
  return `${kb}K`;
}

/** Byte sizes from stat — B / K / M / G, one decimal above 1K. */
export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}G`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}M`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${n}B`;
}

export function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/** Compact home-relative path: /home/you/projects/x -> ~/projects/x */
export function tildify(path: string): string {
  return path.replace(/^\/home\/[^/]+/, "~");
}
