/**
 * Originate orchestration — the PURE wiring that turns a validated "start a fresh
 * session" request into the 2-3 spawn primitive + 2-4 registry/memgate sequence,
 * and decides when the new session is actually DRIVEABLE (not merely booted).
 *
 * Everything here is a side-effect-free decision or an orchestration over INJECTED
 * effects (the gate, the registry mutators, the spawn issuer), so each branch the
 * story names is tested directly; the impure endpoint (server/index.ts) supplies
 * the real effects + the out-of-band snapshot refresh.
 *
 * Story 2-5 contract:
 *  - AC5.2: run the 2-4 memory gate FIRST — block ⇒ refuse with the free-memory
 *    message; warn ⇒ allow with a surfaced caution; ok ⇒ proceed.
 *  - AC5.3: on proceed, write the pending registry row (2-4) BEFORE the spawn
 *    (2-3), flip to active on confirm; on any spawn failure surface loudly and
 *    delete the pending row so no ghost entry survives.
 *  - AC5.4: "driveable" gates on drive-confirm, not boot-confirm — ready only once
 *    resolveTarget resolves the new session in a freshly-refreshed snapshot.
 *  - AC5.5: the request is validated (model allowlist, cwd, name) before anything
 *    runs; a bad field is a 400, never a spawn.
 */
import { resolveTarget } from "../drive/target";
import type { GateDecision } from "./memgate";
import { isAllowedModel } from "./spawn";
import type { SpawnResult } from "./confirm";

// ── AC5.5 — request validation (the tiny surface the endpoint sits behind) ─────

/** The originate request as it arrives off the wire (untrusted shapes). */
export interface OriginateInput {
  cwd?: unknown;
  model?: unknown;
  /** Optional human label for the session. */
  name?: unknown;
}

/** A validated, well-typed originate request — cwd is still confined SEPARATELY. */
export interface OriginateRequest {
  cwd: string;
  model: string;
  /** Empty string when no name was given. */
  name: string;
}

export type ValidationResult =
  | { ok: true; value: OriginateRequest }
  | { ok: false; reason: BadField };

export type BadField = "bad-cwd" | "bad-model" | "bad-name";

/** A name, if given, is a short single-line label — bounded so it can't be abused
 *  as a smuggling channel and can't bloat the registry. */
export const MAX_NAME_LEN = 80;

/**
 * Validate the raw request (AC5.5). Pure and synchronous: it checks the model
 * against the allowlist, that cwd is a non-empty absolute-ish string (the REAL
 * confinement to the home root is async — confineSpawnCwd — and runs next), and that
 * an optional name is a bounded single-line string. The first failing field names
 * the 400 reason; the endpoint maps any failure to HTTP 400.
 */
export function validateOriginateRequest(input: OriginateInput): ValidationResult {
  const { cwd, model, name } = input;
  if (typeof cwd !== "string" || cwd.trim() === "" || !cwd.startsWith("/")) {
    return { ok: false, reason: "bad-cwd" };
  }
  if (typeof model !== "string" || !isAllowedModel(model)) {
    return { ok: false, reason: "bad-model" };
  }
  // Name is optional. When present it must be a bounded single-line string.
  let label = "";
  if (name !== undefined && name !== null) {
    if (typeof name !== "string") return { ok: false, reason: "bad-name" };
    const trimmed = name.trim();
    if (trimmed.length > MAX_NAME_LEN || /[\r\n]/.test(trimmed)) {
      return { ok: false, reason: "bad-name" };
    }
    label = trimmed;
  }
  return { ok: true, value: { cwd, model, name: label } };
}

// ── AC5.2 — memory-gate branch wiring ──────────────────────────────────────────

export type GateOutcome =
  | { proceed: true; caution?: string }
  | { proceed: false; message: string };

/**
 * Map a 2-4 gate decision to the originate branch (AC5.2):
 *   block ⇒ refuse with the "free memory / close <session>" message (naming the
 *           heaviest idle session to close when the gate identified one);
 *   warn  ⇒ proceed, but carry a surfaced caution string;
 *   ok    ⇒ proceed clean.
 */
export function memGateOutcome(decision: GateDecision): GateOutcome {
  if (decision.band === "block") {
    const pct = Math.round(decision.usedRatio * 100);
    const close = decision.closeCandidate;
    const base = `Memory is too tight to start a session (user slice ${pct}% used).`;
    const action = close
      ? ` Free memory by closing ${close.uuid} (heaviest idle session).`
      : " Free memory before starting a new session.";
    return { proceed: false, message: base + action };
  }
  if (decision.band === "warn") {
    const pct = Math.round(decision.usedRatio * 100);
    return {
      proceed: true,
      caution: `Memory is getting tight (user slice ${pct}% used) — starting anyway.`,
    };
  }
  return { proceed: true };
}

// ── AC5.4 — the drive-confirm predicate ────────────────────────────────────────

/**
 * The "driveable" predicate (AC5.4): the new session is ready ONLY when
 * resolveTarget resolves it against the LIVE tmux set — i.e. the snapshot has
 * derived a tmuxSession for it AND that name is in the current live set. This is
 * strictly stronger than the spawn's boot-confirm (a transcript on disk): the pane
 * has to have surfaced into the dashboard's session+tmux derivation. The endpoint
 * forces an out-of-band refresh after new-session, then polls this until it holds.
 */
export function isDriveable(
  session: { tmuxSession?: string } | undefined,
  liveTmux: ReadonlySet<string>,
): boolean {
  return resolveTarget(session, liveTmux).ok;
}

// ── AC5.3 — the originate orchestration (gate → pending → spawn → active) ───────

/** The effects the orchestration drives — injected so the happy/failure paths are
 *  tested with a stubbed spawn and an in-memory registry. */
export interface OriginateDeps {
  /** The 2-4 memory gate decision for the current readings. */
  gate: () => Promise<GateDecision>;
  /** Write the 2-4 pending registry row BEFORE the spawn. */
  writePending: (
    uuid: string,
    fields: { cwd: string; label: string; spawnReason: string },
  ) => Promise<void>;
  /** Issue the already-built 2-3 spawn argv and confirm/reap it. */
  issueSpawn: (uuid: string, cwd: string, model: string) => Promise<SpawnResult>;
  /** Flip the 2-4 registry row to active on confirm. */
  markActive: (uuid: string) => Promise<void>;
  /** Delete the 2-4 pending row on any failure (no ghost). */
  remove: (uuid: string) => Promise<void>;
}

export type OriginateOutcome =
  | {
      ok: true;
      uuid: string;
      tmuxSession: string;
      transcriptPath: string;
      caution?: string;
    }
  | { ok: false; reason: "blocked"; message: string }
  | { ok: false; reason: "spawn-failed"; detail: string };

/**
 * Run originate end-to-end (AC5.2 + AC5.3) over injected effects. Order is
 * load-bearing:
 *   1. gate FIRST — a block returns before any registry/spawn mutation.
 *   2. writePending BEFORE issueSpawn — the crash-window liveness claim.
 *   3. issueSpawn; on confirm flip to active; on ANY failure delete the pending
 *      row (no ghost) and surface the spawn's reason loudly.
 * A warn caution rides through to the ok outcome so the caller can surface it.
 * The DRIVE-confirm gate (AC5.4) is the endpoint's job after this returns ok — a
 * boot-confirmed spawn is not yet reported "ready" until isDriveable holds.
 */
export async function originateSession(
  uuid: string,
  req: OriginateRequest,
  deps: OriginateDeps,
): Promise<OriginateOutcome> {
  const decision = await deps.gate();
  const outcome = memGateOutcome(decision);
  if (!outcome.proceed) {
    return { ok: false, reason: "blocked", message: outcome.message };
  }

  // Pending row BEFORE the spawn (AC5.3 / 2-4 AC4.2).
  await deps.writePending(uuid, {
    cwd: req.cwd,
    label: req.name,
    spawnReason: "originate",
  });

  let result: SpawnResult;
  try {
    result = await deps.issueSpawn(uuid, req.cwd, req.model);
  } catch (err) {
    // The spawn primitive threw (e.g. missing-binary assertion) before producing a
    // result — tear down the pending row so no ghost survives, then surface.
    await deps.remove(uuid);
    return {
      ok: false,
      reason: "spawn-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (!result.ok) {
    await deps.remove(uuid); // failed/reaped spawn ⇒ no ghost entry (AC5.3)
    return { ok: false, reason: "spawn-failed", detail: result.reason };
  }

  await deps.markActive(uuid); // confirmed ⇒ flip pending → active
  return {
    ok: true,
    uuid,
    tmuxSession: result.tmuxSession,
    transcriptPath: result.transcriptPath,
    caution: outcome.proceed ? outcome.caution : undefined,
  };
}
