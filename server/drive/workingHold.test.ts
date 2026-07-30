import { describe, expect, test } from "bun:test";
import { heldWorking } from "./workingHold";

// Contract: a positive reading is always working; after the last positive the
// state holds through blank frames for the hold window, then decays to idle.
describe("heldWorking — flicker-absorbing hold", () => {
  test("a positive reading is working and arms the hold", () => {
    expect(heldWorking("h1", true, 1000)).toBe(true);
    expect(heldWorking("h1", false, 1000 + 2999, 3000)).toBe(true); // inside hold
  });

  test("idle past the hold window decays to idle (and stays idle)", () => {
    heldWorking("h2", true, 1000);
    expect(heldWorking("h2", false, 1000 + 3000, 3000)).toBe(false);
    // the hold was consumed — an immediate re-read doesn't resurrect it
    expect(heldWorking("h2", false, 1000 + 3001, 3000)).toBe(false);
  });

  test("a fresh positive re-arms the hold", () => {
    heldWorking("h3", true, 1000);
    heldWorking("h3", false, 2000, 3000); // held
    heldWorking("h3", true, 2500); // re-armed
    expect(heldWorking("h3", false, 2500 + 2999, 3000)).toBe(true);
  });

  test("a session never seen positive reads idle", () => {
    expect(heldWorking("h4", false, 1000)).toBe(false);
  });
});
