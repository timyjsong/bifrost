/**
 * The auth gate's decision logic — PURE, so the security contract is testable in
 * isolation (the server wires in the async token check + the real request). This
 * is the `confine.ts` analog for Build 0: the load-bearing boundary lives in a
 * pure function with the side effects (token verify, request parsing) injected.
 *
 * Default deny: every `/api/*` request is rejected unless it carries a valid
 * device token, with a deliberately tiny pre-auth allowlist. Host + Origin
 * allowlists close the DNS-rebinding and CSRF vectors the tailnet perimeter does
 * not — the threat is my own browser tricked into cross-origin writes, not an
 * unauthenticated outsider.
 */

export interface GuardInput {
  pathname: string;
  host: string | null;
  origin: string | null;
  tokenValid: boolean; // result of the async token check (false if absent/bad)
  allowedHosts: string[];
  allowedOrigins: string[];
}

export type GuardVerdict =
  | { allow: true }
  | { allow: false; status: number; reason: string };

function isApi(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Did this request arrive over HTTPS? The tailscale-serve → caddy chain rewrites
 * X-Forwarded-Proto but preserves Host, so a matching secure Host is the reliable
 * signal (used to gate HSTS). An empty `secureHost` means "can't tell" → not secure.
 */
export function isSecureRequest(
  proto: string | null,
  host: string | null,
  secureHost: string,
): boolean {
  return proto === "https" || (!!secureHost && host === secureHost);
}

// The ONE /api endpoint reachable without a token (besides health, handled
// first). Enrollment must be pre-auth — it's how the first device gets a token —
// but it still passes the Host/Origin allowlists below.
const PREAUTH_API = new Set(["/api/enroll"]);

export function decide(i: GuardInput): GuardVerdict {
  // Health is a pure liveness probe (no sensitive data) — fully open, so a
  // box-local monitor on any host can reach it.
  if (i.pathname === "/api/health") return { allow: true };

  if (isApi(i.pathname)) {
    // Anti DNS-rebinding: a missing or unlisted Host on an API call is rejected.
    if (!i.host || !i.allowedHosts.includes(i.host)) {
      return { allow: false, status: 403, reason: "bad-host" };
    }
    // Anti-CSRF belt: same-origin / non-browser callers omit Origin (allowed);
    // a PRESENT Origin must be allowlisted.
    if (i.origin && !i.allowedOrigins.includes(i.origin)) {
      return { allow: false, status: 403, reason: "bad-origin" };
    }
  }

  // The static shell (non-/api) and pre-auth endpoints load without a token, so
  // the PWA can boot to show the enroll screen and enrollment can run.
  if (!isApi(i.pathname) || PREAUTH_API.has(i.pathname)) {
    return { allow: true };
  }

  // Everything else under /api/* requires a valid device token.
  if (!i.tokenValid) return { allow: false, status: 401, reason: "no-token" };
  return { allow: true };
}
