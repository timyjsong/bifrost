/**
 * Spawn registry — the thin, spawn-ONLY durable sidecar (Bifrost-originated sessions
 * only). It records `uuid → {cwd, label, spawnReason, state}` so a Bifrost-spawned
 * session survives a crash with enough to resume it; Claude-originated sessions need
 * no sidecar (uuid = transcript filename, cwd = transcript head).
 *
 * Lifecycle (AC4.2): a `pending` row is written BEFORE `tmux new-session` (the
 * boot-window liveness claim), flipped to `active` once the spawn confirms, and
 * DELETED on any failed/reaped spawn — so a half-spawn never leaves a ghost row.
 *
 * Single-writer (AC4.3 / REDTEAM H7): the underlying atomic store builds its temp
 * path as `${path}.tmp.${process.pid}`. Bifrost is ONE process, so two concurrent
 * mutations share that one pid → one tmp → a lost/corrupt row. Every mutation here
 * runs through an in-process single-writer queue, making each read-modify-write
 * atomic against the others; concurrent originates both survive.
 *
 * No `tmux-session` is stored (AC4.4): the drive path resolves the live tmux name
 * every tick (target.ts), and tmux names recycle, so a persisted name only misleads.
 * The registry's whole job is uuid → cwd / label / spawnReason crash-survival; it is
 * never the source of the drive target.
 */
import { readJson, writeJsonAtomic } from "../alerts/store";

const FILE = "spawn-registry.json";

export type SpawnState = "pending" | "active";

export interface RegistryEntry {
  /** The confined cwd the spawn ran in (the value to resume at). */
  cwd: string;
  /** Human label for the session. */
  label: string;
  /** Why Bifrost originated this session (free-form provenance). */
  spawnReason: string;
  /** pending = written before spawn; active = flipped on confirm. */
  state: SpawnState;
}

type Registry = Record<string, RegistryEntry>;

/**
 * The single-writer queue: a serialized promise chain. Each mutation appends to the
 * tail and awaits the prior link, so the read-modify-write below runs to completion
 * before the next one begins — even though both were issued "concurrently". This is
 * the atomicity the PID-scoped temp path (H7) cannot provide on its own.
 */
let tail: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  // Chain off the current tail, but isolate the queue from this job's outcome so a
  // rejected mutation doesn't poison every subsequent one.
  const run = tail.then(job, job);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Read the whole registry (no queue needed — a plain read can't lose a row). */
export async function readRegistry(): Promise<Registry> {
  return readJson<Registry>(FILE, {});
}

/** One entry by uuid, or undefined if absent. */
export async function getEntry(uuid: string): Promise<RegistryEntry | undefined> {
  return (await readRegistry())[uuid];
}

/**
 * Serialized read-modify-write. `mutate` receives the current registry (a fresh
 * read from disk inside the critical section) and returns the next one to persist.
 * Returning the same object after an in-place edit is fine — it is re-serialized.
 */
async function mutate(fn: (reg: Registry) => Registry): Promise<void> {
  return enqueue(async () => {
    const reg = await readRegistry();
    const next = fn(reg);
    await writeJsonAtomic(FILE, next);
  });
}

/**
 * Write the `pending` row BEFORE spawn (AC4.2). The cwd/label/spawnReason are the
 * crash-survival payload; state starts `pending`. Overwrites any prior row for this
 * uuid (a re-originate of the same uuid resets it to pending).
 */
export async function writePending(
  uuid: string,
  fields: { cwd: string; label: string; spawnReason: string },
): Promise<void> {
  await mutate((reg) => {
    reg[uuid] = {
      cwd: fields.cwd,
      label: fields.label,
      spawnReason: fields.spawnReason,
      state: "pending",
    };
    return reg;
  });
}

/**
 * Flip a row to `active` on spawn-confirm (AC4.2). No-ops if the uuid is absent
 * (a deleted/reaped row must not be resurrected as active by a late confirm).
 */
export async function markActive(uuid: string): Promise<void> {
  await mutate((reg) => {
    const entry = reg[uuid];
    if (entry) entry.state = "active";
    return reg;
  });
}

/**
 * Delete a row (AC4.2): the failed/reaped-spawn teardown for the pending entry, so a
 * half-spawn leaves no ghost. Idempotent — deleting an absent uuid is a no-op.
 */
export async function remove(uuid: string): Promise<void> {
  await mutate((reg) => {
    delete reg[uuid];
    return reg;
  });
}

/**
 * Reap rows whose crash-survival window has closed. A row matters ONLY while
 * its session is transcript-less: once a transcript exists, uuid + cwd are
 * recoverable from it (exactly like a Claude-originated session), and a dead
 * session with no transcript has nothing to resume. Rules, per row:
 *   - transcript exists            → drop (redundant with the transcript)
 *   - no transcript AND not live   → drop (unrecoverable — nothing to resume)
 *   - no transcript AND live       → keep (the boot/first-turn window: this row
 *                                    and the pid-file are the only evidence)
 * Probes are injected (snapshot-derived liveness, transcript lookup) so the
 * policy is pure and testable. Returns the dropped uuids.
 */
export async function reapRegistry(probes: {
  transcriptExists: (uuid: string) => boolean;
  isLive: (uuid: string) => boolean;
}): Promise<string[]> {
  const dropped: string[] = [];
  await mutate((reg) => {
    for (const uuid of Object.keys(reg)) {
      if (probes.transcriptExists(uuid) || !probes.isLive(uuid)) {
        delete reg[uuid];
        dropped.push(uuid);
      }
    }
    return reg;
  });
  return dropped;
}

/** Test-only: drain the single-writer queue so a test can await all pending writes. */
export async function _drain(): Promise<void> {
  await tail;
}
