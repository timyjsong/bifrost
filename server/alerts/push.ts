/**
 * Web Push transport: the subscription store + the VAPID-signed sender.
 *
 * Store is minimal · robust · scalable: one JSON file, atomic writes, keyed by
 * endpoint (re-subscribe dedups), self-pruning (a sub that returns 410/404 is
 * dropped on the next send). N devices by construction.
 */
import webpush, { type PushSubscription } from "web-push";
import { readJson, writeJsonAtomic } from "./store";
import { loadVapid } from "./vapid";

const SUBS_FILE = "push-subscriptions.json";

let subs: PushSubscription[] | null = null;

async function load(): Promise<PushSubscription[]> {
  if (!subs) subs = await readJson<PushSubscription[]>(SUBS_FILE, []);
  return subs;
}

async function persist(): Promise<void> {
  await writeJsonAtomic(SUBS_FILE, subs ?? []);
}

export async function addSubscription(sub: PushSubscription): Promise<number> {
  if (!sub?.endpoint) throw new Error("subscription missing endpoint");
  const list = await load();
  const i = list.findIndex((s) => s.endpoint === sub.endpoint);
  if (i >= 0) list[i] = sub;
  else list.push(sub);
  await persist();
  return list.length;
}

export async function removeSubscription(endpoint: string): Promise<number> {
  const list = await load();
  subs = list.filter((s) => s.endpoint !== endpoint);
  await persist();
  return subs.length;
}

export async function subscriptionCount(): Promise<number> {
  return (await load()).length;
}

let configured = false;
async function configure(): Promise<void> {
  if (configured) return;
  const v = await loadVapid();
  webpush.setVapidDetails(v.subject, v.publicKey, v.privateKey);
  configured = true;
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

/** Fan out to every subscription; prune the dead ones (410 Gone / 404). */
export async function sendToAll(
  payload: PushPayload,
): Promise<{ sent: number; pruned: number }> {
  await configure();
  const list = await load();
  if (list.length === 0) return { sent: 0, pruned: 0 };
  const data = JSON.stringify(payload);
  const dead: string[] = [];
  let sent = 0;
  await Promise.all(
    list.map(async (s) => {
      try {
        await webpush.sendNotification(s, data);
        sent++;
      } catch (err) {
        const code = (err as { statusCode?: number })?.statusCode;
        if (code === 404 || code === 410) {
          dead.push(s.endpoint);
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[bifrost] push send failed (${code ?? "?"}): ${msg}`);
        }
      }
    }),
  );
  if (dead.length) {
    subs = list.filter((s) => !dead.includes(s.endpoint));
    await persist();
  }
  return { sent, pruned: dead.length };
}
