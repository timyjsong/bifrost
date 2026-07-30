import { describe, expect, test } from "bun:test";
import { resolveDriveTarget } from "./driveTarget";

const G = 6_000;

describe("resolveDriveTarget — J8 race states", () => {
  test("present → driving", () => {
    expect(
      resolveDriveTarget({ present: true, everPresent: false, msSinceOpen: 0, graceMs: G }),
    ).toBe("driving");
    expect(
      resolveDriveTarget({ present: true, everPresent: true, msSinceOpen: 999999, graceMs: G }),
    ).toBe("driving");
  });

  test("just opened, not yet in snapshot, within grace → resolving (don't bounce)", () => {
    expect(
      resolveDriveTarget({ present: false, everPresent: false, msSinceOpen: 1000, graceMs: G }),
    ).toBe("resolving");
  });

  test("was present then dropped out → gone (ended mid-drive, even within grace)", () => {
    expect(
      resolveDriveTarget({ present: false, everPresent: true, msSinceOpen: 500, graceMs: G }),
    ).toBe("gone");
  });

  test("never appeared and past the grace → gone (dead / unknown id)", () => {
    expect(
      resolveDriveTarget({ present: false, everPresent: false, msSinceOpen: G + 1, graceMs: G }),
    ).toBe("gone");
  });
});
