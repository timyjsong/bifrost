/**
 * Web Push client: service-worker registration, the gesture-triggered subscribe
 * flow, and the policy fetch/save. The pure bits — the status classifier and the
 * VAPID key decode — are split out and unit-tested; the rest wraps browser APIs
 * (navigator/Notification/PushManager) and only runs in the page.
 */
import type { AlertPolicy } from "../../../shared/alerts";

export type PushStatus =
  | "unsupported" // no SW/Push and not an installable iOS case
  | "needs-homescreen" // iOS Safari: Add to Home Screen first
  | "default" // supported, not yet asked
  | "denied" // permission refused
  | "subscribed"; // good — alerts will arrive

export interface PushEnv {
  supported: boolean; // ServiceWorker + PushManager + Notification all present
  standalone: boolean; // running as an installed PWA
  permission: NotificationPermission;
  subscribed: boolean;
  iosSafari: boolean; // iOS, where PushManager only exists once installed
}

/** Pure: map the observed browser environment to a single status. */
export function classifyPushStatus(env: PushEnv): PushStatus {
  if (env.subscribed) return "subscribed";
  if (env.permission === "denied") return "denied";
  if (!env.supported) {
    if (env.iosSafari && !env.standalone) return "needs-homescreen";
    return "unsupported";
  }
  return "default";
}

/** Pure: VAPID application server key (URL-safe base64) → bytes for subscribe(). */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ---- browser runtime ------------------------------------------------------

export function detectEnv(subscribed: boolean): PushEnv {
  const supported =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  const iosSafari = /iP(hone|ad|od)/.test(navigator.userAgent);
  const permission = "Notification" in window ? Notification.permission : "default";
  return { supported, standalone, permission, subscribed, iosSafari };
}

export async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js");
  } catch (err) {
    console.error("[bifrost] service worker registration failed", err);
  }
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Must be called from a user gesture (iOS ignores requestPermission otherwise). */
export async function enableAlerts(): Promise<{ ok: boolean; reason?: string }> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: permission };
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await fetch("/api/push/vapid").then((r) => r.json());
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sub),
  });
  return { ok: true };
}

export async function disableAlerts(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await fetch("/api/push/unsubscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});
  await sub.unsubscribe();
}

export async function sendTestPush(): Promise<{ sent: number; pruned: number }> {
  return fetch("/api/push/test", { method: "POST" }).then((r) => r.json());
}

/** Per-session mute — the per-card toggle. Server keeps the canonical set; the
 *  next snapshot reflects it via session.alertsEnabled. */
export async function setSessionAlerts(sessionId: string, enabled: boolean): Promise<void> {
  await fetch("/api/alerts/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, enabled }),
  }).catch(() => {});
}

// ---- policy ---------------------------------------------------------------

const POLICY_CACHE = "bifrost.alertPolicy";

export function cachedPolicy(): AlertPolicy | null {
  try {
    const raw = localStorage.getItem(POLICY_CACHE);
    return raw ? (JSON.parse(raw) as AlertPolicy) : null;
  } catch {
    return null;
  }
}

export async function fetchPolicy(): Promise<AlertPolicy> {
  const policy = await fetch("/api/alerts/policy")
    .then((r) => r.json())
    .then((d) => d.policy as AlertPolicy);
  try {
    localStorage.setItem(POLICY_CACHE, JSON.stringify(policy));
  } catch {
    /* storage full / disabled — server copy is canonical anyway */
  }
  return policy;
}

export async function savePolicy(policy: AlertPolicy): Promise<AlertPolicy> {
  try {
    localStorage.setItem(POLICY_CACHE, JSON.stringify(policy));
  } catch {
    /* ignore */
  }
  return fetch("/api/alerts/policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ policy }),
  })
    .then((r) => r.json())
    .then((d) => d.policy as AlertPolicy);
}
