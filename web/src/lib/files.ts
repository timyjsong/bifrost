import type { DirListing } from "../../../shared/types";

/**
 * Fetch a directory listing from the confined `/api/files` endpoint. Throws on a
 * non-2xx (the server's `error` reason surfaces as the message) so callers can
 * render it.
 */
export async function fetchDir(
  path: string,
  showHidden: boolean,
): Promise<DirListing> {
  const qs = new URLSearchParams({ path });
  if (showHidden) qs.set("all", "1");
  const res = await fetch(`/api/files?${qs}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}
