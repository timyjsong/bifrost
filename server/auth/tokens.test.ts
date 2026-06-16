import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the data store at a throwaway dir BEFORE importing the module that reads
// it (store.ts resolves dataDir at import time from BIFROST_DATA_DIR).
let dir: string;
let tokens: typeof import("./tokens");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bifrost-auth-"));
  process.env.BIFROST_DATA_DIR = dir;
  tokens = await import("./tokens");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("mint → verify roundtrip", async () => {
  const t = await tokens.mintToken("laptop", 1000);
  expect(await tokens.verifyToken(t)).toBe(true);
});

test("rejects unknown, empty, and null tokens", async () => {
  expect(await tokens.verifyToken("nope")).toBe(false);
  expect(await tokens.verifyToken("")).toBe(false);
  expect(await tokens.verifyToken(null)).toBe(false);
});

test("revokeByLabel removes the device's token", async () => {
  const t = await tokens.mintToken("phone", 2000);
  expect(await tokens.verifyToken(t)).toBe(true);
  expect(await tokens.revokeByLabel("phone")).toBeGreaterThanOrEqual(1);
  expect(await tokens.verifyToken(t)).toBe(false);
});

test("revokeAll clears every device", async () => {
  await tokens.mintToken("a", 1);
  await tokens.mintToken("b", 2);
  await tokens.revokeAll();
  expect((await tokens.listDevices()).length).toBe(0);
});

test("tokens are 256-bit (43 base64url chars) and unique", () => {
  const a = tokens.newToken();
  const b = tokens.newToken();
  expect(a).not.toBe(b);
  expect(a.length).toBe(43); // 32 bytes base64url, unpadded
});

test("listDevices exposes an 8-char id (token prefix)", async () => {
  await tokens.revokeAll();
  const t = await tokens.mintToken("laptop", 1000);
  const [d] = await tokens.listDevices();
  expect(d.id).toBe(t.slice(0, 8));
  expect(d.id.length).toBe(8);
});

test("revokeByTokenPrefix removes only the matching device", async () => {
  await tokens.revokeAll();
  const t1 = await tokens.mintToken("safari", 1);
  const t2 = await tokens.mintToken("pwa", 2);
  expect(await tokens.revokeByTokenPrefix(t1.slice(0, 8))).toBe(1);
  expect(await tokens.verifyToken(t1)).toBe(false);
  expect(await tokens.verifyToken(t2)).toBe(true); // the other device survives
});

test("revokeByTokenPrefix ignores a too-short prefix (no over-broad wipe)", async () => {
  await tokens.revokeAll();
  const t = await tokens.mintToken("a", 1);
  expect(await tokens.revokeByTokenPrefix("abc")).toBe(0); // < 6 chars
  expect(await tokens.verifyToken(t)).toBe(true);
});
