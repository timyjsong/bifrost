/**
 * Device tokens — the persisted credential set for Build 0 auth. Each enrolled
 * device holds one opaque 256-bit bearer token; the server keeps the set in the
 * non-served data dir (0600, the same store as the VAPID secret) and checks a
 * presented token against it in constant time. Opaque + server-side means
 * revocation is just removing an entry — no signing, no crypto to get wrong.
 *
 * The in-memory cache is mtime-invalidated (the `claudeJson` pattern), so a token
 * minted or revoked by the box CLI — a different process — is honored by the
 * running server on its very next request, no restart needed.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { dataDir, writeJsonAtomic } from "../alerts/store";

const FILE = "auth-tokens.json";
const BAK = `${FILE}.bak`;
const PATH = join(dataDir, FILE);
const BAK_PATH = join(dataDir, BAK);

export interface DeviceToken {
  token: string; // base64url, 32 random bytes (256-bit)
  label: string; // human label, set at enrollment
  createdAt: number;
}

let cache: { mtimeMs: number; list: DeviceToken[] } | null = null;

async function fileMtime(): Promise<number> {
  try {
    return (await stat(PATH)).mtimeMs;
  } catch {
    return 0; // missing file → mtime 0, distinct from any real write
  }
}

type ReadResult =
  | { kind: "ok"; list: DeviceToken[] }
  | { kind: "missing" }
  | { kind: "corrupt" };

// A STRICT read that tells "no file yet" (legitimately empty) apart from
// "present but unreadable/corrupt". The generic readJson() collapses both to its
// fallback []; that is the wipe vector — a transient bad read returns [], and the
// next save() persists [] over a perfectly good store. Here only a genuine ENOENT
// yields empty; anything else is reported corrupt so load() refuses to clobber.
async function readList(path: string): Promise<ReadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "corrupt" };
  }
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? { kind: "ok", list: v as DeviceToken[] } : { kind: "corrupt" };
  } catch {
    return { kind: "corrupt" };
  }
}

async function load(): Promise<DeviceToken[]> {
  const mtimeMs = await fileMtime();
  if (cache && cache.mtimeMs === mtimeMs) return cache.list;

  const main = await readList(PATH);
  if (main.kind === "ok") {
    cache = { mtimeMs, list: main.list };
    return main.list;
  }
  // Primary missing or corrupt → recover from the mirror before doing anything.
  const bak = await readList(BAK_PATH);
  if (bak.kind === "ok") {
    await writeJsonAtomic(FILE, bak.list); // self-heal the primary from the backup
    cache = { mtimeMs: await fileMtime(), list: bak.list };
    return bak.list;
  }
  if (main.kind === "missing") {
    cache = { mtimeMs, list: [] }; // genuine first run — no primary, no backup
    return [];
  }
  // Corrupt primary AND no usable backup: fail closed. Throwing makes callers
  // 500 (the client keeps its token) and, crucially, never reach a save([]) — so
  // a bad read can't cascade into a wipe of every enrolled device.
  throw new Error(
    "auth-tokens.json is corrupt and no valid backup exists — refusing to operate",
  );
}

async function save(list: DeviceToken[]): Promise<void> {
  await writeJsonAtomic(FILE, list);
  await writeJsonAtomic(BAK, list); // mirror for corruption/loss recovery
  cache = { mtimeMs: await fileMtime(), list };
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Mint + persist a device token. Returns the raw token (shown once). */
export async function mintToken(label: string, now: number): Promise<string> {
  const token = newToken();
  const list = await load();
  await save([...list, { token, label: label.slice(0, 64) || "device", createdAt: now }]);
  return token;
}

/**
 * Constant-time check that `presented` matches some stored token. Every stored
 * token is touched (no early break) and the comparison is timing-safe, so neither
 * which token matched nor how many exist leaks via timing. A length mismatch
 * can't match (all tokens are the same length) and short-circuits safely.
 */
export async function verifyToken(presented: string | null): Promise<boolean> {
  if (!presented) return false;
  const a = Buffer.from(presented);
  let ok = false;
  for (const { token } of await load()) {
    const b = Buffer.from(token);
    if (a.length === b.length && timingSafeEqual(a, b)) ok = true;
  }
  return ok;
}

export interface DeviceInfo {
  id: string; // first 8 chars of the token — disambiguates same-labelled devices
  label: string;
  createdAt: number;
}

export async function listDevices(): Promise<DeviceInfo[]> {
  return (await load()).map(({ token, label, createdAt }) => ({
    id: token.slice(0, 8),
    label,
    createdAt,
  }));
}

/** Revoke every token with this label (CLI op). Returns how many were removed. */
export async function revokeByLabel(label: string): Promise<number> {
  const list = await load();
  const kept = list.filter((d) => d.label !== label);
  await save(kept);
  return list.length - kept.length;
}

/** Revoke one device by its `list` id (token prefix) — for same-labelled devices. */
export async function revokeByTokenPrefix(prefix: string): Promise<number> {
  if (prefix.length < 6) return 0; // guard against an over-broad match
  const list = await load();
  const kept = list.filter((d) => !d.token.startsWith(prefix));
  await save(kept);
  return list.length - kept.length;
}

export async function revokeAll(): Promise<void> {
  await save([]);
}

/** Test-only: drop the in-memory cache so a fresh read hits disk. */
export function _resetCache(): void {
  cache = null;
}
