/**
 * Enrollment codes — short-lived, single-use bootstrap secrets. Minted on the box
 * (the enroll CLI), presented once by a new device to trade for a durable device
 * token. A code lives only in server memory with a TTL: reaching the tailnet IP
 * can't mint a token, you need a code that only box access produces.
 */
import { randomBytes } from "node:crypto";

export const ENROLL_TTL_MS = 10 * 60 * 1000; // 10 minutes

const codes = new Map<string, number>(); // code -> expiresAt (epoch ms)

export function newEnrollCode(): string {
  // 12 bytes -> 16 base64url chars: high entropy, short enough to read/type.
  return randomBytes(12).toString("base64url");
}

/** Mint + register a code valid for ENROLL_TTL_MS from `now`. */
export function mintEnrollCode(now: number): { code: string; expiresAt: number } {
  const code = newEnrollCode();
  const expiresAt = now + ENROLL_TTL_MS;
  codes.set(code, expiresAt);
  return { code, expiresAt };
}

/**
 * Validate AND consume a code: true only if present and unexpired. Always deletes
 * the code (single-use) and opportunistically sweeps expired entries.
 */
export function consumeEnrollCode(code: string, now: number): boolean {
  const expiresAt = codes.get(code);
  for (const [c, exp] of codes) if (exp <= now) codes.delete(c);
  if (expiresAt === undefined) return false;
  codes.delete(code);
  return expiresAt > now;
}

/** Test-only: clear all pending codes. */
export function _clear(): void {
  codes.clear();
}
