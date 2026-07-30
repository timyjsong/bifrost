import type { DirListing, DirPick } from "../../../shared/types";
import { apiFetch } from "./api";

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
  const res = await apiFetch(`/api/files?${qs}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch the originate picker's directory listing (`/api/dirs` — dirs only,
 * home-rooted). No `path` starts at the browse root. Throws on a non-2xx.
 */
export async function fetchDirs(path?: string): Promise<DirPick> {
  const qs = path ? `?${new URLSearchParams({ path })}` : "";
  const res = await apiFetch(`/api/dirs${qs}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}
