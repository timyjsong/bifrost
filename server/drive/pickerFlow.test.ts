import { describe, expect, test } from "bun:test";
import { withPickerLock } from "./pickerFlow";

const op = (log: string[], id: string, ms: number) => () =>
  new Promise<string>((resolve) => {
    log.push(`${id}:start`);
    setTimeout(() => {
      log.push(`${id}:end`);
      resolve(id);
    }, ms);
  });

describe("withPickerLock — serialize picker ops per session", () => {
  test("same-session ops run strictly in order — never interleaved (no Esc race)", async () => {
    const log: string[] = [];
    const a = withPickerLock("s1", op(log, "a", 30));
    const b = withPickerLock("s1", op(log, "b", 5)); // shorter, but must wait for a
    await Promise.all([a, b]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  test("different sessions run concurrently", async () => {
    const log: string[] = [];
    const x = withPickerLock("x", op(log, "x", 30));
    const y = withPickerLock("y", op(log, "y", 5)); // other session → not blocked
    await Promise.all([x, y]);
    expect(log.indexOf("y:end")).toBeLessThan(log.indexOf("x:end"));
  });

  test("a throwing op doesn't wedge the session's queue", async () => {
    await expect(
      withPickerLock("z", () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(await withPickerLock("z", () => Promise.resolve("recovered"))).toBe("recovered");
  });
});
