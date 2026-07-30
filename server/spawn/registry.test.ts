import { afterEach, describe, expect, test } from "bun:test";

import {
  _drain,
  getEntry,
  markActive,
  readRegistry,
  remove,
  writePending,
  type RegistryEntry,
  reapRegistry,
} from "./registry";
import { readJson } from "../alerts/store";

// Each test starts from an empty registry. test-setup.ts already isolates the data
// dir at BIFROST_DATA_DIR; we just clear the file's rows between tests via remove().
async function reset(): Promise<void> {
  await _drain();
  for (const uuid of Object.keys(await readRegistry())) await remove(uuid);
  await _drain();
}
afterEach(reset);

const PENDING = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  cwd: "/home/you/proj",
  label: "proj",
  spawnReason: "originate",
  state: "pending",
  ...over,
});

// ── AC4.1 — schema + atomic round-trip ────────────────────────────────────────
describe("AC4.1 registry stores uuid → {cwd,label,spawnReason,state}, atomic round-trip", () => {
  test("a written entry round-trips byte-for-byte through disk", async () => {
    const uuid = "aaaa0000-0000-4000-8000-000000000001";
    await writePending(uuid, { cwd: "/home/you/a", label: "A", spawnReason: "originate" });
    await _drain();

    expect(await getEntry(uuid)).toEqual(PENDING({ cwd: "/home/you/a", label: "A" }));

    // The persisted shape is exactly the documented record under the gitignored file,
    // keyed by uuid — read it back raw, not via the module cache.
    const raw = await readJson<Record<string, RegistryEntry>>("spawn-registry.json", {});
    expect(raw[uuid]).toEqual({
      cwd: "/home/you/a",
      label: "A",
      spawnReason: "originate",
      state: "pending",
    });
  });

  test("state is constrained to pending | active across the lifecycle", async () => {
    const uuid = "aaaa0000-0000-4000-8000-000000000002";
    await writePending(uuid, { cwd: "/home/you/b", label: "B", spawnReason: "r" });
    await _drain();
    expect((await getEntry(uuid))!.state).toBe("pending");
    await markActive(uuid);
    await _drain();
    expect((await getEntry(uuid))!.state).toBe("active");
  });
});

// ── AC4.2 — pending → active → confirm; failed/reaped deletes (no ghosts) ──────
describe("AC4.2 pending-before-spawn, flip-to-active-on-confirm, delete-on-fail", () => {
  test("writePending writes a pending row; markActive flips it in place", async () => {
    const uuid = "bbbb0000-0000-4000-8000-000000000001";
    await writePending(uuid, { cwd: "/home/you/c", label: "C", spawnReason: "originate" });
    await _drain();
    expect((await getEntry(uuid))!.state).toBe("pending");

    await markActive(uuid);
    await _drain();
    const after = await getEntry(uuid)!;
    expect(after).toEqual(PENDING({ cwd: "/home/you/c", label: "C", state: "active" }));
  });

  test("a failed/reaped spawn deletes the pending entry — no ghost left behind", async () => {
    const uuid = "bbbb0000-0000-4000-8000-000000000002";
    await writePending(uuid, { cwd: "/home/you/d", label: "D", spawnReason: "originate" });
    await _drain();
    expect(await getEntry(uuid)).toBeDefined();

    await remove(uuid); // teardown path for collision / confirm-timeout
    await _drain();
    expect(await getEntry(uuid)).toBeUndefined();
    // and it's gone from the durable file, not just the in-memory view
    const raw = await readJson<Record<string, RegistryEntry>>("spawn-registry.json", {});
    expect(raw[uuid]).toBeUndefined();
  });

  test("markActive on an already-deleted uuid does NOT resurrect it (late confirm)", async () => {
    const uuid = "bbbb0000-0000-4000-8000-000000000003";
    await writePending(uuid, { cwd: "/home/you/e", label: "E", spawnReason: "r" });
    await remove(uuid);
    await markActive(uuid); // a confirm that lands after the reap
    await _drain();
    expect(await getEntry(uuid)).toBeUndefined();
  });
});

// ── AC4.3 — concurrent mutations serialize; both rows survive ──────────────────
describe("AC4.3 single-writer queue: two concurrent writes both survive", () => {
  test("two concurrently-issued writePending calls both persist (no lost row)", async () => {
    const u1 = "cccc0000-0000-4000-8000-000000000001";
    const u2 = "cccc0000-0000-4000-8000-000000000002";

    // Issue BOTH without awaiting between them — the read-modify-write of each races
    // the other. Without the queue, the second read sees pre-first-write state and
    // its write drops u1's row (H7 lost-update). The queue serializes them.
    await Promise.all([
      writePending(u1, { cwd: "/home/you/1", label: "one", spawnReason: "r" }),
      writePending(u2, { cwd: "/home/you/2", label: "two", spawnReason: "r" }),
    ]);
    await _drain();

    const reg = await readRegistry();
    expect(reg[u1]).toBeDefined();
    expect(reg[u2]).toBeDefined();
    expect(reg[u1].label).toBe("one");
    expect(reg[u2].label).toBe("two");
  });

  test("a burst of concurrent writes all survive (stress the queue)", async () => {
    const uuids = Array.from(
      { length: 12 },
      (_, i) => `dddd0000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
    );
    await Promise.all(
      uuids.map((u, i) =>
        writePending(u, { cwd: `/home/you/${i}`, label: `s${i}`, spawnReason: "r" }),
      ),
    );
    await _drain();

    const reg = await readRegistry();
    for (const u of uuids) expect(reg[u]).toBeDefined();
    expect(Object.keys(reg).length).toBe(uuids.length);
  });

  test("concurrent write + delete on different uuids don't clobber each other", async () => {
    const keep = "eeee0000-0000-4000-8000-000000000001";
    const drop = "eeee0000-0000-4000-8000-000000000002";
    await writePending(drop, { cwd: "/home/you/x", label: "x", spawnReason: "r" });
    await _drain();

    await Promise.all([
      writePending(keep, { cwd: "/home/you/k", label: "k", spawnReason: "r" }),
      remove(drop),
    ]);
    await _drain();

    const reg = await readRegistry();
    expect(reg[keep]).toBeDefined(); // the concurrent write survived
    expect(reg[drop]).toBeUndefined(); // the concurrent delete applied
  });
});

// ── AC4.4 — no authoritative tmux-session name is stored ───────────────────────
describe("AC4.4 registry never stores an authoritative tmux-session name", () => {
  test("a persisted entry carries no tmux-session field (asserted by absence)", async () => {
    const uuid = "ffff0000-0000-4000-8000-000000000001";
    await writePending(uuid, { cwd: "/home/you/y", label: "Y", spawnReason: "originate" });
    await _drain();

    const raw = await readJson<Record<string, Record<string, unknown>>>(
      "spawn-registry.json",
      {},
    );
    const entry = raw[uuid];
    expect(entry).toBeDefined();
    // The whole schema is exactly these four keys — no tmux name in any spelling.
    expect(Object.keys(entry).sort()).toEqual(["cwd", "label", "spawnReason", "state"]);
    expect(entry).not.toHaveProperty("tmuxSession");
    expect(entry).not.toHaveProperty("tmux-session");
    expect(entry).not.toHaveProperty("sessionName");
  });
});

describe("reapRegistry — the crash-survival window", () => {
  const seed = async () => {
    await writePending("t-live", { cwd: "/x", label: "", spawnReason: "originate" });
    await markActive("t-live");
    await writePending("t-tx", { cwd: "/x", label: "", spawnReason: "originate" });
    await markActive("t-tx");
    await writePending("t-dead", { cwd: "/x", label: "", spawnReason: "originate" });
    await markActive("t-dead");
    await writePending("t-boot", { cwd: "/x", label: "", spawnReason: "restart-fresh" });
  };

  test("transcript exists → dropped; dead without transcript → dropped; live transcript-less → kept", async () => {
    await seed();
    const dropped = await reapRegistry({
      transcriptExists: (u) => u === "t-tx",
      isLive: (u) => u === "t-live" || u === "t-boot",
    });
    expect(dropped.sort()).toEqual(["t-dead", "t-tx"]);
    const reg = await readRegistry();
    expect(Object.keys(reg).sort()).toEqual(["t-boot", "t-live"]);
    // cleanup
    await remove("t-live");
    await remove("t-boot");
  });

  test("an empty registry reaps to nothing without error", async () => {
    expect(await reapRegistry({ transcriptExists: () => true, isLive: () => false })).toEqual([]);
  });
});
