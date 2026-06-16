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
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { dataDir, readJson, writeJsonAtomic } from "../alerts/store";

const FILE = "auth-tokens.json";
const PATH = join(dataDir, FILE);

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

async function load(): Promise<DeviceToken[]> {
  const mtimeMs = await fileMtime();
  if (cache && cache.mtimeMs === mtimeMs) return cache.list;
  const list = await readJson<DeviceToken[]>(FILE, []);
  cache = { mtimeMs, list };
  return list;
}

async function save(list: DeviceToken[]): Promise<void> {
  await writeJsonAtomic(FILE, list);
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

export async function listDevices(): Promise<Omit<DeviceToken, "token">[]> {
  return (await load()).map(({ label, createdAt }) => ({ label, createdAt }));
}

/** Revoke every token with this label (CLI op). Returns how many were removed. */
export async function revokeByLabel(label: string): Promise<number> {
  const list = await load();
  const kept = list.filter((d) => d.label !== label);
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
