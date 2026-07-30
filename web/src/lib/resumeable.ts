/**
 * Client wiring for the project-centric resumeable list (story 2-2).
 *
 * - `useSessionIndex`: fetch the full *uncapped* session index once so the
 *   name-search box can match in-memory per keystroke (AC2.2 — no network
 *   round-trip per keystroke). Refetched only when the snapshot's session set
 *   changes (a new/ended session), never on a keystroke.
 * - `setPin`: toggle a session's pin (AC2.3) — the server persists it and the
 *   next snapshot stamps `pinned`/rescues a dropped session.
 */
import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import type { SessionIndexEntry } from "../../../shared/types";

/** Toggle a session's pin server-side. Returns true on success. */
export async function setPin(sessionId: string, pinned: boolean): Promise<boolean> {
  try {
    const res = await apiFetch("/api/sessions/pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, pinned }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The full uncapped session index for client-side name search. Fetched once and
 * cached in state; `refreshKey` lets the caller refetch when the live session
 * set changes (so a freshly-renamed or new session shows up in search) without
 * coupling to every keystroke. Returns `[]` until the first fetch resolves.
 */
export function useSessionIndex(refreshKey: unknown): SessionIndexEntry[] {
  const [entries, setEntries] = useState<SessionIndexEntry[]>([]);
  useEffect(() => {
    let alive = true;
    void apiFetch("/api/session-index")
      .then((r) => (r.ok ? r.json() : { entries: [] }))
      .then((d: { entries?: SessionIndexEntry[] }) => {
        if (alive) setEntries(d.entries ?? []);
      })
      .catch(() => {
        /* offline — keep the last index; search just runs over what we have */
      });
    return () => {
      alive = false;
    };
  }, [refreshKey]);
  return entries;
}

export interface ContentHit {
  sessionId: string;
  projectSlug: string;
  snippet: string;
  mtimeMs: number;
}

/** Content search across every transcript (server-side grep; ≥3 chars). */
export async function searchContent(q: string): Promise<ContentHit[]> {
  if (q.trim().length < 3) return [];
  try {
    const r = await apiFetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
    if (!r.ok) return [];
    return ((await r.json()) as { hits?: ContentHit[] }).hits ?? [];
  } catch {
    return [];
  }
}
