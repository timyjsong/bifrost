import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the data store at a throwaway dir BEFORE importing the disk-backed module.
let dir: string;
let enroll: typeof import("./enroll");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bifrost-enroll-"));
  process.env.BIFROST_DATA_DIR = dir;
  enroll = await import("./enroll");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await enroll._clear();
});

test("a valid code consumes exactly once", async () => {
  const { code } = await enroll.mintEnrollCode(1000);
  expect(await enroll.consumeEnrollCode(code, 1000)).toBe(true);
  expect(await enroll.consumeEnrollCode(code, 1000)).toBe(false); // single-use
});

test("an expired code is rejected", async () => {
  const { code, expiresAt } = await enroll.mintEnrollCode(1000);
  expect(await enroll.consumeEnrollCode(code, expiresAt + 1)).toBe(false);
});

test("a code is valid right up to (but not at) expiry", async () => {
  const { code, expiresAt } = await enroll.mintEnrollCode(1000);
  expect(await enroll.consumeEnrollCode(code, expiresAt - 1)).toBe(true);
});

test("an unknown code is rejected", async () => {
  expect(await enroll.consumeEnrollCode("not-a-real-code", 1000)).toBe(false);
});

test("codes are unique per mint", async () => {
  const a = (await enroll.mintEnrollCode(1000)).code;
  const b = (await enroll.mintEnrollCode(1000)).code;
  expect(a).not.toBe(b);
});

test("minting a fresh code sweeps an expired one", async () => {
  const stale = (await enroll.mintEnrollCode(1000)).code;
  await enroll.mintEnrollCode(1000 + enroll.ENROLL_TTL_MS + 1); // now past stale's expiry
  expect(await enroll.consumeEnrollCode(stale, 1000 + enroll.ENROLL_TTL_MS + 2)).toBe(false);
});

// The single-use guarantee has to survive two devices posting the same code at
// once — the failure mode is two valid tokens minted from one code, which is the
// whole point of the code being single-use.
test("concurrent consumes of one code: exactly one wins", async () => {
  const { code } = await enroll.mintEnrollCode(1000);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => enroll.consumeEnrollCode(code, 1001)),
  );
  expect(results.filter(Boolean).length).toBe(1);
});

test("concurrent consumes of distinct codes each win exactly once", async () => {
  const codes = await Promise.all(
    Array.from({ length: 4 }, () => enroll.mintEnrollCode(1000).then((r) => r.code)),
  );
  const results = await Promise.all(
    codes.flatMap((c) => [
      enroll.consumeEnrollCode(c, 1001),
      enroll.consumeEnrollCode(c, 1001),
    ]),
  );
  expect(results.filter(Boolean).length).toBe(4);
});
