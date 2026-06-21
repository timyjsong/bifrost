/**
 * App-wide settings — a tiny server-stored config the UI edits. Today it holds
 * just the send grace period: how long a submitted prompt is parked before it's
 * actually injected, during which a stop cancels it. Stored server-side (not in
 * the browser) so the countdown the UI shows and the timer that actually fires
 * read the SAME value, and so it's shared across devices. Reuses the durable
 * atomic JSON store under data/.
 */
import { readJson, writeJsonAtomic } from "./alerts/store";

const FILE = "settings.json";

export interface Settings {
  /** Grace period (ms) before a submitted prompt is injected; 0 = send now. */
  sendDelayMs: number;
}

const DEFAULTS: Settings = { sendDelayMs: 3000 };
const MAX_DELAY_MS = 30_000;

let cache: Settings | null = null;

/** Validate + clamp incoming/loaded values into a sane Settings, so a corrupt
 *  file or a bad PUT can never produce a negative or absurd delay. Exported so
 *  the clamp contract is unit-tested without touching the on-disk store. */
export function clean(s: Partial<Settings> | null | undefined): Settings {
  const raw = Number(s?.sendDelayMs);
  const sendDelayMs = Number.isFinite(raw)
    ? Math.min(Math.max(0, Math.round(raw)), MAX_DELAY_MS)
    : DEFAULTS.sendDelayMs;
  return { sendDelayMs };
}

export async function getSettings(): Promise<Settings> {
  if (!cache) cache = clean(await readJson<Partial<Settings> | null>(FILE, null));
  return cache;
}

/** Merge a partial patch over current settings, validate, persist. Returns the
 *  effective settings so the caller echoes back exactly what took. */
export async function setSettings(patch: Partial<Settings> | null): Promise<Settings> {
  const next = clean({ ...(await getSettings()), ...(patch ?? {}) });
  cache = next;
  await writeJsonAtomic(FILE, next);
  return next;
}
