import { describe, expect, test } from "bun:test";
import { classifyPushStatus, urlBase64ToUint8Array, type PushEnv } from "./push";

const env = (o: Partial<PushEnv> = {}): PushEnv => ({
  supported: true,
  standalone: true,
  permission: "default",
  subscribed: false,
  iosSafari: false,
  ...o,
});

describe("classifyPushStatus", () => {
  test("a live subscription wins over everything", () => {
    expect(classifyPushStatus(env({ subscribed: true }))).toBe("subscribed");
  });
  test("denied permission surfaces as denied", () => {
    expect(classifyPushStatus(env({ permission: "denied" }))).toBe("denied");
  });
  test("supported and not yet asked → default (ready to enable)", () => {
    expect(classifyPushStatus(env())).toBe("default");
  });
  test("iOS Safari not yet installed → needs-homescreen", () => {
    expect(
      classifyPushStatus(env({ supported: false, iosSafari: true, standalone: false })),
    ).toBe("needs-homescreen");
  });
  test("iOS installed but APIs missing (old iOS) → unsupported", () => {
    expect(
      classifyPushStatus(env({ supported: false, iosSafari: true, standalone: true })),
    ).toBe("unsupported");
  });
  test("non-iOS without push support → unsupported", () => {
    expect(classifyPushStatus(env({ supported: false, iosSafari: false }))).toBe("unsupported");
  });
  test("a denial outranks the home-screen hint", () => {
    expect(
      classifyPushStatus(
        env({ supported: false, iosSafari: true, standalone: false, permission: "denied" }),
      ),
    ).toBe("denied");
  });
});

describe("urlBase64ToUint8Array", () => {
  const toUrlSafe = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  test("round-trips bytes including the high range", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(Array.from(urlBase64ToUint8Array(toUrlSafe(bytes)))).toEqual(Array.from(bytes));
  });

  test("restores values when padding was stripped", () => {
    const bytes = new Uint8Array([65, 66, 67, 68, 69]); // length 5 → 2 pad chars stripped
    expect(Array.from(urlBase64ToUint8Array(toUrlSafe(bytes)))).toEqual([65, 66, 67, 68, 69]);
  });
});
