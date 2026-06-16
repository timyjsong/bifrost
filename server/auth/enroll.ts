/**
 * Enrollment codes — short-lived, single-use bootstrap secrets. Minted on the box
 * (the enroll CLI) and presented once by a new device to trade for a durable
 * device token. Disk-backed in the data dir so the CLI process and the server
 * process share them: reaching the tailnet IP can't mint a token — you need a
 * code that only box access produces, and it expires.
 */
import { randomBytes } from "node:crypto";
import { readJson, writeJsonAtomic } from "../alerts/store";

const FILE = "enroll-codes.json";
export const ENROLL_TTL_MS = 10 * 60 * 1000; // 10 minutes

type CodeMap = Record<string, number>; // code -> expiresAt (epoch ms)

export function newEnrollCode(): string {
  // 12 bytes -> 16 base64url chars: high entropy, short enough to read/type.
  return randomBytes(12).toString("base64url");
}

/** Mint + persist a code valid for ENROLL_TTL_MS from `now`. Sweeps expired. */
export async function mintEnrollCode(
  now: number,
): Promise<{ code: string; expiresAt: number }> {
  const code = newEnrollCode();
  const expiresAt = now + ENROLL_TTL_MS;
  const codes = await readJson<CodeMap>(FILE, {});
  for (const [c, exp] of Object.entries(codes)) if (exp <= now) delete codes[c];
  codes[code] = expiresAt;
  await writeJsonAtomic(FILE, codes);
  return { code, expiresAt };
}

/**
 * Validate AND consume a code: true only if present and unexpired. Always deletes
 * the code (single-use) and opportunistically sweeps expired entries.
 */
export async function consumeEnrollCode(code: string, now: number): Promise<boolean> {
  const codes = await readJson<CodeMap>(FILE, {});
  const expiresAt = codes[code];
  let changed = false;
  for (const [c, exp] of Object.entries(codes)) if (exp <= now) { delete codes[c]; changed = true; }
  if (code in codes) { delete codes[code]; changed = true; } // single-use consume
  if (changed) await writeJsonAtomic(FILE, codes);
  return expiresAt !== undefined && expiresAt > now;
}

/** Test-only: drop all pending codes. */
export async function _clear(): Promise<void> {
  await writeJsonAtomic(FILE, {});
}
