import { describe, expect, test } from "bun:test";
import { exceedsBodyCap, isUploadPath, bodyCapFor, JSON_BODY_CAP, MAX_BODY_BYTES } from "./http";

describe("body-size caps — pre-auth memory-amplification guard", () => {
  test("the upload route gets the large cap; every other route the small one", () => {
    expect(isUploadPath("/api/session/abc-123/upload")).toBe(true);
    expect(bodyCapFor("/api/session/abc-123/upload")).toBe(MAX_BODY_BYTES);
    expect(bodyCapFor("/api/enroll")).toBe(JSON_BODY_CAP);
    expect(bodyCapFor("/api/session/abc/prompt")).toBe(JSON_BODY_CAP);
  });

  test("a huge DECLARED body on a JSON route is rejected (the enroll DoS)", () => {
    expect(exceedsBodyCap("/api/enroll", String(50 * 1024 * 1024))).toBe(true);
    expect(exceedsBodyCap("/api/enroll", String(JSON_BODY_CAP + 1))).toBe(true);
  });

  test("a normal JSON body passes", () => {
    expect(exceedsBodyCap("/api/enroll", "512")).toBe(false);
    expect(exceedsBodyCap("/api/session/x/draft", String(200 * 1024))).toBe(false);
  });

  test("a 25MB upload passes (multi-file headroom under the global cap)", () => {
    expect(exceedsBodyCap("/api/session/x/upload", String(25 * 1024 * 1024))).toBe(false);
    // but a body over the global backstop is still rejected even on upload
    expect(exceedsBodyCap("/api/session/x/upload", String(MAX_BODY_BYTES + 1))).toBe(true);
  });

  test("no Content-Length (chunked) is not rejected here — the serve backstop handles it", () => {
    expect(exceedsBodyCap("/api/enroll", null)).toBe(false);
  });

  test("a malformed Content-Length is left to the parser, not falsely rejected", () => {
    expect(exceedsBodyCap("/api/enroll", "not-a-number")).toBe(false);
    expect(exceedsBodyCap("/api/enroll", "-5")).toBe(false);
  });
});
