/**
 * Client wiring for originate (story 2-5): the picker's PURE validation + the
 * POST to /api/originate. The validation mirrors the server's tiny surface so the
 * dialog can enable/disable "start" locally — the server re-validates and is the
 * real boundary; this is just so the UI doesn't fire a request it knows is bad.
 *
 *  - AC5.1: the picker offers cwd (default = project root), a model from the
 *    allowlist, and an optional name. validateOriginate decides if it's startable.
 *  - AC5.5: the server rejects a bad model/cwd/name with a 400; the same field
 *    rules live here so the UI surfaces the problem before the round-trip.
 */
import { apiFetch } from "./api";

import { SPAWN_MODELS } from "../../../shared/types";

/** The pickable models — re-exported from the shared SINGLE SOURCE. */
export const ORIGINATE_MODELS = SPAWN_MODELS;

export type ModelAlias = (typeof SPAWN_MODELS)[number]["alias"];

const MODEL_ALIASES: readonly string[] = ORIGINATE_MODELS.map((m) => m.alias);

/** Mirror of the server's name bound (server/spawn/originate.ts MAX_NAME_LEN). */
export const MAX_NAME_LEN = 80;

export interface OriginateForm {
  cwd: string;
  model: string;
  name: string;
}

export type OriginateValidation =
  | { ok: true }
  | { ok: false; field: "cwd" | "model" | "name"; message: string };

/**
 * Decide whether the picker's current form is startable (AC5.1) — the same field
 * rules the server enforces (AC5.5), so the "start" button reflects the server's
 * verdict without a round-trip. cwd here is only checked for shape (non-empty,
 * absolute); the REAL home-root confinement is the server's canonicalizing check.
 */
export function validateOriginate(form: OriginateForm): OriginateValidation {
  if (!form.cwd.trim() || !form.cwd.startsWith("/")) {
    return { ok: false, field: "cwd", message: "Pick an absolute folder under the server\u2019s home directory." };
  }
  if (!MODEL_ALIASES.includes(form.model)) {
    return { ok: false, field: "model", message: "Pick a model." };
  }
  const name = form.name.trim();
  if (name.length > MAX_NAME_LEN || /[\r\n]/.test(name)) {
    return {
      ok: false,
      field: "name",
      message: `Name must be one line, ${MAX_NAME_LEN} characters or fewer.`,
    };
  }
  return { ok: true };
}

export type OriginateResponse =
  | { ok: true; sessionId: string; tmuxSession: string; caution?: string; driveable: boolean }
  | { ok: false; reason: string; message?: string; detail?: string };

/**
 * POST the originate request. Resolves to the parsed body for any HTTP status the
 * server returns (400/409/502 all carry a structured reason), so the caller can
 * surface the exact failure. Throws only on a transport/parse failure.
 */
export async function originate(form: OriginateForm): Promise<OriginateResponse> {
  const res = await apiFetch("/api/originate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: form.cwd, model: form.model, name: form.name.trim() }),
  });
  return (await res.json()) as OriginateResponse;
}
