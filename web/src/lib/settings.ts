import { apiFetch } from "./api";

/** App settings mirror (server is the source of truth). */
export interface Settings {
  /** Send grace period (ms) before a submitted prompt is injected; 0 = send now. */
  sendDelayMs: number;
}

export const DEFAULT_SETTINGS: Settings = { sendDelayMs: 3000 };

export async function fetchSettings(): Promise<Settings> {
  try {
    const r = await apiFetch("/api/settings");
    if (!r.ok) return DEFAULT_SETTINGS;
    return (await r.json()) as Settings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  try {
    const r = await apiFetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) return DEFAULT_SETTINGS;
    return (await r.json()) as Settings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}
