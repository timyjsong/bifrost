/**
 * The alert manager: the one stateful seam between the poll loop and Web Push.
 * Holds the policy (loaded from disk, edited via the API), the engine state, and
 * the derivation tracker. `evaluateAlerts` runs once per fast tick; the HTTP
 * handlers serve the subscribe flow and the policy editor.
 */
import type { SessionInfo, SystemInfo } from "../../shared/types";
import { type AlertPolicy, mergePolicy } from "../../shared/alerts";
import { evaluate, type EngineState } from "./engine";
import { deriveReadings, emptyDeriveState, type DeriveState } from "./readings";
import { collectAlertSources } from "./sources";
import { loadVapid } from "./vapid";
import {
  addSubscription,
  removeSubscription,
  sendToAll,
  subscriptionCount,
} from "./push";
import { readJson, writeJsonAtomic } from "./store";
import { setSessionAlerts } from "./sessions";

const POLICY_FILE = "alert-policy.json";

let policy: AlertPolicy | null = null;
let engineState: EngineState = {};
let deriveState: DeriveState = emptyDeriveState();

async function getPolicy(): Promise<AlertPolicy> {
  if (!policy) policy = mergePolicy(await readJson<AlertPolicy | null>(POLICY_FILE, null));
  return policy;
}

async function setPolicy(input: unknown): Promise<AlertPolicy> {
  const merged = mergePolicy(input as Partial<AlertPolicy>);
  policy = merged;
  await writeJsonAtomic(POLICY_FILE, merged);
  return merged;
}

/** One evaluation pass. Engine step is synchronous; sends are fire-and-forget. */
export async function evaluateAlerts(
  system: SystemInfo,
  sessions: SessionInfo[],
  now: number,
): Promise<void> {
  const pol = await getPolicy();
  const sources = await collectAlertSources();
  const { readings, next: nextDerive } = deriveReadings(
    sources,
    system,
    sessions,
    pol,
    deriveState,
    now,
  );
  deriveState = nextDerive;
  const { fired, next } = evaluate(readings, pol, engineState, now);
  engineState = next;

  for (const a of fired) {
    sendToAll({ title: a.title, body: a.body, tag: a.tag, url: "/" })
      .then((r) => {
        if (r.sent || r.pruned) {
          console.log(`[bifrost] alert ${a.id} → ${r.sent} sent, ${r.pruned} pruned`);
        }
      })
      .catch((e) => console.error(`[bifrost] alert ${a.id} send failed:`, e));
  }
}

async function readBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/** Returns a Response for a /api/push/* or /api/alerts/* route, else null. */
export async function handleAlertRequest(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;

  if (p === "/api/push/vapid" && req.method === "GET") {
    const v = await loadVapid();
    return Response.json({ publicKey: v.publicKey });
  }

  if (p === "/api/push/subscribe" && req.method === "POST") {
    const sub = (await readBody(req)) as { endpoint?: string } | null;
    if (!sub?.endpoint) return Response.json({ error: "invalid subscription" }, { status: 400 });
    const count = await addSubscription(sub as Parameters<typeof addSubscription>[0]);
    return Response.json({ ok: true, count });
  }

  if (p === "/api/push/unsubscribe" && req.method === "POST") {
    const body = (await readBody(req)) as { endpoint?: string } | null;
    if (!body?.endpoint) return Response.json({ error: "missing endpoint" }, { status: 400 });
    const count = await removeSubscription(body.endpoint);
    return Response.json({ ok: true, count });
  }

  if (p === "/api/push/test" && req.method === "POST") {
    const r = await sendToAll({
      title: "Bifrost",
      body: "Push is wired up — you'll get alerts here.",
      tag: "bifrost-test",
      url: "/",
    });
    return Response.json({ ...r, subscriptions: await subscriptionCount() });
  }

  if (p === "/api/alerts/policy" && req.method === "GET") {
    return Response.json({ policy: await getPolicy() });
  }

  if (p === "/api/alerts/policy" && req.method === "PUT") {
    const body = (await readBody(req)) as { policy?: AlertPolicy } | AlertPolicy | null;
    const incoming = (body && "policy" in body ? body.policy : body) ?? null;
    return Response.json({ policy: await setPolicy(incoming) });
  }

  if (p === "/api/alerts/session" && req.method === "POST") {
    const body = (await readBody(req)) as { sessionId?: string; enabled?: boolean } | null;
    if (!body?.sessionId || typeof body.enabled !== "boolean") {
      return Response.json({ error: "sessionId + enabled required" }, { status: 400 });
    }
    await setSessionAlerts(body.sessionId, body.enabled);
    return Response.json({ ok: true });
  }

  return null;
}
