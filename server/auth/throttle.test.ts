import { test, expect, beforeEach } from "bun:test";
import {
  isThrottled,
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
