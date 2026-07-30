/**
 * VAPID keypair — generated once, persisted, reused. The private key is a
 * secret: it lives in the non-served data dir, never in a served directory or the repo.
 * The public key is handed to the browser (it's baked into each subscription).
 */
import webpush from "web-push";
import { readJson, writeJsonAtomic } from "./store";

const FILE = "vapid.json";
// Neutral fallback — the real contact comes from cfg.alerts.vapidSubject via
// setVapidSubject at boot (an existing keypair keeps its persisted subject).
let SUBJECT = "mailto:admin@example.com";

export function setVapidSubject(subject: string): void {
  SUBJECT = subject;
}

export interface Vapid {
  subject: string;
  publicKey: string;
  privateKey: string;
}

let cached: Vapid | null = null;

export async function loadVapid(): Promise<Vapid> {
  if (cached) return cached;
  const existing = await readJson<Vapid | null>(FILE, null);
  if (existing?.publicKey && existing.privateKey) {
    cached = { ...existing, subject: existing.subject || SUBJECT };
    return cached;
  }
  const keys = webpush.generateVAPIDKeys();
  cached = { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey };
  await writeJsonAtomic(FILE, cached);
  console.log("[bifrost] generated a new VAPID keypair → data/vapid.json");
  return cached;
}
