/**
 * Auth-aware fetch for the Bifrost PWA. Every /api call carries the device token
 * in the `X-Bifrost-Token` header — the custom-header requirement is what blocks
 * CSRF by construction. A 401 means the token is missing or revoked: clear it and
 * fire `bifrost-auth-lost` so App drops back to the enroll screen.
 */
const TOKEN_KEY = "bifrost.token";
export const AUTH_LOST_EVENT = "bifrost-auth-lost";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage disabled — the in-page session still works until reload */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

function authHeaders(init?: HeadersInit): Headers {
  const h = new Headers(init);
  const t = getToken();
  if (t) h.set("X-Bifrost-Token", t);
  return h;
}

function onUnauthorized(): void {
  clearToken();
  window.dispatchEvent(new Event(AUTH_LOST_EVENT));
}

/** fetch() with the token attached; a 401 trips the enroll flow and throws. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, { ...init, headers: authHeaders(init.headers) });
  if (res.status === 401) {
    onUnauthorized();
    throw new Error("unauthenticated");
  }
  return res;
}

export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Stream Server-Sent Events over fetch() — NOT EventSource, which cannot send a
 * custom header, so the token couldn't ride along. Parses `event:`/`data:` frames
 * and ignores `:` heartbeat comments. A 401 trips the enroll flow; the caller owns
 * reconnection via the AbortSignal.
 */
export async function* sseStream(
  path: string,
  signal: AbortSignal,
): AsyncGenerator<SseFrame> {
  const res = await fetch(path, { headers: authHeaders(), signal });
  if (res.status === 401) {
    onUnauthorized();
    throw new Error("unauthenticated");
  }
  if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) yield { event, data };
    }
  }
}
