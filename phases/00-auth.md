# Phase 0 (Build 0) — Auth / Security

**Status:** PLANNED — agreed in principle; full requirements + ACs locked at phase
start. No greenlight yet.

**Why first:** hard ship-gate on the very first write endpoint. Cross-cutting,
independently testable, de-risks everything after. There must be no window where a
write-capable endpoint exists unauthenticated.

## Goal
A single-user auth layer that lets only my enrolled devices drive Bifrost, robust
against the one vector the tailnet perimeter does NOT cover: the browser tricked into
cross-origin writes (CSRF / DNS-rebinding).

## Decision (Option A)
- **Bearer token in a custom header** (e.g. `X-Bifrost-Token`) — the custom-header
  requirement kills CSRF by construction (browsers won't attach it cross-origin
  without a preflight Bifrost refuses).
- **Strict CORS + Origin/Host allowlist** (kills DNS-rebinding).
- **Auth enforced IN the app**, not just caddy — both routes (raw `:4444` and the
  HTTPS serve route) must enforce it; a caddy-only gate leaves `:4444` open.
- **Per-device one-time enrollment**; the PWA persists the token. Reuse the `data/`
  secret pattern (VAPID keys, 0700/0600).
- **Push usage to the HTTPS route** (`https://dev.your-tailnet.ts.net:8444`) — secure
  context for credentials / service worker / push.

Not chosen: B (Tailscale identity passthrough — unneeded, no other users; possible
later layer). C (passkeys/WebAuthn — future upgrade, over-weight now).

## Standing rules
- **NEVER Funnel Bifrost.** (Funnel currently routes to a separate secret-path-gated
  service on `:18080`, not Bifrost — verified 2026-06-16. Keep it that way.)
- Accepted residual: device compromise = full access (unavoidable for a personal tool).

## Open / to-decide at phase start
- Enrollment UX: paste token vs QR-from-the-box vs one-time link.
- Gate reads too, or only writes? (Lean: gate everything once auth exists — session
  content is now sensitive, and it's simpler.)
- Token rotation / revocation (likely minimal v1: regenerate + re-enroll).
- Where the token is minted/stored on the box; format (random vs signed).

## Verification (success criteria → tests)
- Unauthenticated request to a write endpoint → 401.
- Cross-origin request (forged Origin / no custom header) → rejected.
- Bad/expired token → 401.
- Enrolled device with valid token → 200.
- Both routes (`:4444` and HTTPS) enforce identically.

## Gate
I greenlight Build 0's locked requirements before code starts.
