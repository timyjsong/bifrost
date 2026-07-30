import { describe, expect, test } from "bun:test";
import { clearSendFailure, recordSendFailure, sendFailure } from "./sendFailures";

// Contract: a fire-time failure is readable by every device until a fresh send
// attempt (or a successful fire) clears it; reads never consume it.
describe("sendFailures", () => {
  test("a recorded failure is readable, repeatedly (reads don't consume)", () => {
    recordSendFailure("s1", "session-gone", 1000);
    expect(sendFailure("s1")).toEqual({ at: 1000, reason: "session-gone" });
    expect(sendFailure("s1")).toEqual({ at: 1000, reason: "session-gone" });
    clearSendFailure("s1");
  });

  test("a session with no failure reads null", () => {
    expect(sendFailure("nope")).toBeNull();
  });

  test("a newer failure overwrites the older one", () => {
    recordSendFailure("s2", "session-gone", 1000);
    recordSendFailure("s2", "send-error", 2000);
    expect(sendFailure("s2")).toEqual({ at: 2000, reason: "send-error" });
    clearSendFailure("s2");
  });

  test("clear removes the record", () => {
    recordSendFailure("s3", "send-error", 1000);
    clearSendFailure("s3");
    expect(sendFailure("s3")).toBeNull();
  });
});
