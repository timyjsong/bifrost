/**
 * Attached-file uploads for the drive composer. The tmux TUI can't take binaries,
 * so an attachment is saved here and its absolute PATH is injected into the prompt
 * for Claude to read. Files live OUTSIDE any session's (git-tracked) project —
 * under the gitignored, owner-only data/uploads/<sessionId>/ — and are TTL-swept
 * on each upload (no separate timer needed).
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, stat, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../alerts/store";

const ROOT = join(dataDir, "uploads");
const TTL_MS = 24 * 60 * 60 * 1000; // delete uploads older than 24h

/** A traversal-safe directory key from a sessionId (UUIDs in practice). Pure. */
export function safeSid(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 80) || "unknown";
}

/** A filesystem-safe, collision-resistant name from a client filename: strip any
 *  path, allow only a safe charset, cap length, and prefix a random token so two
 *  files named the same don't clobber. Pure (token passed in) → tested. */
export function safeUploadName(filename: string, token: string): string {
  const base =
    (filename.split(/[/\\]/).pop() || "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) ||
    "file";
  return `${token}-${base}`;
}

/** TTL check — pure, so the sweep policy is tested. */
export function isExpired(mtimeMs: number, now: number, ttlMs = TTL_MS): boolean {
  return now - mtimeMs > ttlMs;
}

/** Delete uploads older than the TTL across all sessions; drop emptied dirs.
 *  Best-effort — a vanished file or unreadable dir is skipped, never thrown. */
export async function sweepUploads(now: number, ttlMs = TTL_MS): Promise<void> {
  let sids: string[];
  try {
    sids = await readdir(ROOT);
  } catch {
    return; // nothing uploaded yet
  }
  for (const sid of sids) {
    const dir = join(ROOT, sid);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const s = await stat(join(dir, f));
        if (isExpired(s.mtimeMs, now, ttlMs)) await rm(join(dir, f), { force: true });
      } catch {
        /* vanished between readdir and stat */
      }
    }
    try {
      if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Save one uploaded file under data/uploads/<sessionId>/, returning its absolute
 *  path (what gets injected into the prompt) and the stored name. */
export async function saveUpload(
  sessionId: string,
  filename: string,
  bytes: Uint8Array,
): Promise<{ path: string; name: string }> {
  const dir = join(ROOT, safeSid(sessionId));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = safeUploadName(filename, randomBytes(4).toString("hex"));
  const path = join(dir, name);
  await writeFile(path, bytes, { mode: 0o600 });
  return { path, name };
}
