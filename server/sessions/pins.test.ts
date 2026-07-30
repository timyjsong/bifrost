import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../alerts/store";
import { pinnedSessions, setSessionPin, _resetPinCache } from "./pins";

// The store writes only into BIFROST_DATA_DIR (test-setup.ts points it at a temp
// dir — never the real data/). Reset the in-memory cache + the file between tests.
afterEach(async () => {
  _resetPinCache();
  await rm(join(dataDir, "pinned-sessions.json"), { force: true });
});

describe("pin store (mirrors alert-sessions.json)", () => {
  test("a fresh store has no pins", async () => {
    expect([...(await pinnedSessions())]).toEqual([]);
  });

  test("pinning adds the id; unpinning removes it", async () => {
    await setSessionPin("s1", true);
    expect((await pinnedSessions()).has("s1")).toBe(true);
    await setSessionPin("s1", false);
    expect((await pinnedSessions()).has("s1")).toBe(false);
  });

  test("pins persist across a cache reset (re-read from disk)", async () => {
    await setSessionPin("keep", true);
    _resetPinCache();
    expect((await pinnedSessions()).has("keep")).toBe(true);
  });

  test("unpinning an absent id is a no-op", async () => {
    await setSessionPin("ghost", false);
    expect([...(await pinnedSessions())]).toEqual([]);
  });
});
