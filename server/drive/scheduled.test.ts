import { describe, expect, test } from "bun:test";
import { schedule, cancel, isPending } from "./scheduled";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("scheduled — the server-side send grace buffer", () => {
  test("a parked send fires after the delay; isPending tracks the window", async () => {
    let fired = false;
    schedule("s-fire", 30, () => {
      fired = true;
    });
    expect(isPending("s-fire")).toBe(true);
    expect(fired).toBe(false);
    await wait(60);
    expect(fired).toBe(true);
    expect(isPending("s-fire")).toBe(false); // cleared once it fires
  });

  test("cancel within the window aborts the fire and returns true", async () => {
    let fired = false;
    schedule("s-cancel", 50, () => {
      fired = true;
    });
    expect(cancel("s-cancel")).toBe(true);
    expect(isPending("s-cancel")).toBe(false);
    await wait(80);
    expect(fired).toBe(false); // never fired
  });

  test("cancel with nothing pending returns false (the already-fired race)", () => {
    expect(cancel("s-nothing")).toBe(false);
  });

  test("scheduling supersedes: the first parked send is cancelled, only the second fires", async () => {
    const fired: string[] = [];
    schedule("s-supersede", 40, () => {
      fired.push("first");
    });
    schedule("s-supersede", 40, () => {
      fired.push("second"); // replaces the first
    });
    await wait(80);
    expect(fired).toEqual(["second"]);
  });

  test("delayMs <= 0 still fires asynchronously and stays cancellable in-tick", async () => {
    let fired = false;
    schedule("s-immediate", 0, () => {
      fired = true;
    });
    expect(fired).toBe(false); // not synchronous — setTimeout(0) defers
    expect(cancel("s-immediate")).toBe(true); // still cancellable this tick
    await wait(20);
    expect(fired).toBe(false);
  });
});
