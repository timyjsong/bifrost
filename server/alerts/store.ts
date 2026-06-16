/**
 * Tiny durable JSON store: atomic writes (temp + rename), under a non-served
 * data dir. The VAPID key, the subscription list, and the alert policy all live
 * here. Kept behind this module so swapping to SQLite later is a one-file change.
 *
 * `data/` is gitignored and never web-served (serveStatic only exposes web/dist;
 * /api/* routes are explicit) — safe for the VAPID private key.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "../config";

export const dataDir = process.env.BIFROST_DATA_DIR ?? join(repoRoot, "data");

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(join(dataDir, file), "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  // 0700 dir / 0600 files — the VAPID private key lives here; keep it owner-only.
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, file);
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, path); // atomic on the same filesystem
}
