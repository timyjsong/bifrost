import { test, expect, beforeEach } from "bun:test";
import {
  isThrottled,
  throttleBlocks,
  recordFailure,
  _clear,
  THROTTLE_MAX_FAILS,
  THROTTLE_WINDOW_MS,
} from "./throttle";

beforeEach(() => _clear());

test("throttles only after MAX failures in the window", () => {
  for (let i = 0; i < THROTTLE_MAX_FAILS - 1; i++) recordFailure("1.2.3.4", 1000 + i);
  expect(isThrottled("1.2.3.4", 1100)).toBe(false);
  recordFailure("1.2.3.4", 1100);
  expect(isThrottled("1.2.3.4", 1101)).toBe(true);
});

test("the sliding window expires old failures", () => {
  for (let i = 0; i < THROTTLE_MAX_FAILS; i++) recordFailure("1.2.3.4", 1000);
  expect(isThrottled("1.2.3.4", 1000)).toBe(true);
  expect(isThrottled("1.2.3.4", 1000 + THROTTLE_WINDOW_MS + 1)).toBe(false);
});

test("throttling is per-IP", () => {
  for (let i = 0; i < THROTTLE_MAX_FAILS; i++) recordFailure("1.1.1.1", 1000);
  expect(isThrottled("2.2.2.2", 1000)).toBe(false);
});

test("throttleBlocks: a VALID token is never blocked, even from a throttled IP", () => {
  // A shared caddy IP is over the limit from other clients' failed auths…
  for (let i = 0; i < THROTTLE_MAX_FAILS; i++) recordFailure("10.0.0.1", 1000);
  expect(isThrottled("10.0.0.1", 1000)).toBe(true);
  // …a valid-token device behind that same IP still gets through.
  expect(throttleBlocks(true, "10.0.0.1", 1000)).toBe(false);
  // …an unauthenticated request from that IP is blocked (brute-force intact).
  expect(throttleBlocks(false, "10.0.0.1", 1000)).toBe(true);
});

test("throttleBlocks: an unauthenticated request under the limit passes", () => {
  expect(throttleBlocks(false, "10.0.0.2", 1000)).toBe(false);
});
