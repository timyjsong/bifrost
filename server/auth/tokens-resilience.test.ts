// Persistence-hardening regression tests (pre-mortem, 2026-06-21). These pin the
// behaviours that stop `data/auth-tokens.json` from being silently wiped: a
// corrupt/missing primary recovers from the .bak mirror, and a corrupt store
// with no usable backup fails CLOSED (throws) rather than clobbering to [].
//
// They operate on the store's actual (test-isolated) dataDir — see test-setup.ts,
// which points BIFROST_DATA_DIR at a temp dir before any import freezes the path.
import { test, expect, beforeEach } from "bun:test";
import { writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../alerts/store";
import * as tokens from "./tokens";

const PATH = join(dataDir, "auth-tokens.json");
const BAK = join(dataDir, "auth-tokens.json.bak");

async function seed(labels: string[]): Promise<void> {
  await tokens.revokeAll(); // clean slate (writes primary + mirror)
  for (let i = 0; i < labels.length; i++) {
    await tokens.mintToken(labels[i], (i + 1) * 1000);
  }
}

beforeEach(async () => {
  await rm(BAK, { force: true });
  await tokens.revokeAll();
  tokens._resetCache();
});

test("a corrupt primary is recovered from the backup, not wiped, on the next write", async () => {
  await seed(["desktop", "phone"]);
  await writeFile(PATH, '{"partial":'); // transient corruption / partial write
  tokens._resetCache();
  const t = await tokens.mintToken("new", 9000);
  const labels = (await tokens.listDevices()).map((d) => d.label).sort();
  expect(labels).toEqual(["desktop", "new", "phone"]); // originals survived
  expect(await tokens.verifyToken(t)).toBe(true);
});

test("a missing primary with a valid backup self-heals", async () => {
  await seed(["laptop"]);
  await rm(PATH, { force: true }); // primary gone, mirror intact
  tokens._resetCache();
  expect((await tokens.listDevices()).map((d) => d.label)).toEqual(["laptop"]);
  // the primary was rewritten from the backup
  expect(JSON.parse(await readFile(PATH, "utf8"))).toHaveLength(1);
});

test("corrupt primary AND corrupt backup fails closed (throws) — never clobbers", async () => {
  await seed(["desktop"]);
  await writeFile(PATH, "garbage");
  await writeFile(BAK, "also garbage");
  tokens._resetCache();
  await expect(tokens.verifyToken("anything")).rejects.toThrow();
  expect(await readFile(PATH, "utf8")).toBe("garbage"); // NOT overwritten to []
});

test("genuine first run (no primary, no backup) is a clean empty store", async () => {
  await rm(PATH, { force: true });
  await rm(BAK, { force: true });
  tokens._resetCache();
  expect(await tokens.listDevices()).toEqual([]);
});

test("an intentional revokeAll still empties the store (not treated as corruption)", async () => {
  await seed(["a", "b"]);
  await tokens.revokeAll();
  tokens._resetCache();
  expect(await tokens.listDevices()).toEqual([]);
});
