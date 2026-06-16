import { test, expect, beforeEach } from "bun:test";
import { mintEnrollCode, consumeEnrollCode, _clear } from "./enroll";

beforeEach(() => _clear());

test("a valid code consumes exactly once", () => {
  const { code } = mintEnrollCode(1000);
  expect(consumeEnrollCode(code, 1000)).toBe(true);
  expect(consumeEnrollCode(code, 1000)).toBe(false); // single-use
});

test("an expired code is rejected", () => {
  const { code, expiresAt } = mintEnrollCode(1000);
  expect(consumeEnrollCode(code, expiresAt + 1)).toBe(false);
});

test("a code is valid right up to (but not at) expiry", () => {
  const { code, expiresAt } = mintEnrollCode(1000);
  expect(consumeEnrollCode(code, expiresAt - 1)).toBe(true);
});

test("an unknown code is rejected", () => {
  expect(consumeEnrollCode("not-a-real-code", 1000)).toBe(false);
});

test("codes are unique per mint", () => {
  const a = mintEnrollCode(1000).code;
  const b = mintEnrollCode(1000).code;
  expect(a).not.toBe(b);
});
