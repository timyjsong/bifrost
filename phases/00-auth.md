# Phase 0 (Build 0) — Auth / Security

**Status: BUILT & CONVERGED — deployed to prod 2026-06-16.** Gate live and
enforcing on both routes; two devices enrolled (desktop + iOS PWA). All
verification ACs pass live. As-built refinements recorded at the bottom.

Robustness dialed UP per my explicit call (2026-06-16): *"make it more robust
than you currently think it needs — once we're past Phase 0 there's a chance I
forget to harden it later."* So Build 0 is specced to be **safe to leave
unattended indefinitely**, within the structural ceiling of a bearer-token scheme
(see *Ceiling*). Setup must stay **easy** (my other constraint).

**Why first:** hard ship-gate on the very first write endpoint — there must be no
window where a write-capable endpoint exists unauthenticated. Cross-cutting,
independently testable, de-risks everything after.

## Goal
Single-user auth: only my enrolled devices can drive Bifrost. Robust against the
one vector the tailnet perimeter does NOT cover — the browser tricked into
cross-origin writes (CSRF / DNS-rebinding) — and hardened to be set-and-forget.

## Locked decisions
1. **Gate everything, not just writes.** Once auth exists, gate-all is simpler (no
   read/write classification to maintain) and session content (transcripts,
   think-streams) is sensitive. The currently-open read-only dashboard stops working
   until a device is enrolled — accepted.
2. **Per-device random opaque tokens.** 256-bit from CSPRNG (`crypto.randomBytes`),
   base64url. Stored server-side as a set in `data/` (0600), reusing the VAPID
   secret pattern (`server/alerts/vapid.ts`). No JWT/signing — opaque + server-side
   store gives free revocation and zero crypto surface. Compared in **constant time**
   (`timingSafeEqual`).
3. **Revocation = minimal, per-device.** Revoke one device = delete its entry;
   nuke-all = clear the set. No rotation/refresh infra.
4. **Enrollment: box-minted one-time code → token.** Easy AND gated (see below).

## Enrollment model (keystone — easy setup *and* robust)
Root of trust = "can read from the box as that user" — the same boundary as everything
else on this machine.
- A CLI on the box (e.g. `bun run enroll`) mints a **one-time enrollment code**
  (high-entropy, single-use, short TTL ~10 min) and renders it as a copyable string
  **and a QR** (QR encodes the HTTPS enroll URL + code).
- On the device: open the PWA / scan the QR → POST the code to the pre-auth
  `/api/enroll` → server validates (single-use + unexpired) → issues a per-device
  256-bit token + device label → PWA persists it (IndexedDB) → every later request
  carries `X-Bifrost-Token`.
- **Easy:** scan the QR from the box, done. **Robust:** enrollment requires box
  access to obtain the code — reaching the tailnet IP alone can't mint a token.

## The gate (fail-closed, central, single chokepoint)
- The server is a single `Bun.serve({ fetch })` handler (`server/index.ts:297`) —
  exactly one place every request flows through. The gate sits at the TOP of `fetch`,
  before route dispatch.
- **Default-deny:** every request → 401 unless it (a) carries a valid token, or
  (b) hits the explicit **pre-auth allowlist**, kept deliberately tiny:
  `/api/health`, `/api/enroll`, and the static shell (so the PWA can load to show the
  enroll screen). NOT opt-in per route — default-deny, allowlist the exceptions.
- **Fail-closed on errors:** token store missing/corrupt/unreadable → deny all.
  Never fail open.
- **Both routes enforce identically** — enforcement is in-app, so raw `:4444` and the
  HTTPS serve route are gated the same. A caddy-only gate would leave `:4444` open —
  rejected.

## Anti-CSRF / anti-rebinding (Option A, hardened)
- **Custom header `X-Bifrost-Token`** — browsers won't attach a custom header
  cross-origin without a preflight Bifrost refuses → CSRF blocked by construction.
- **Strict CORS** — explicit origin allowlist (the two known tailnet origins only),
  no wildcard, preflight refused for disallowed origins.
- **Host/Origin allowlist** — reject any request whose Host ∉
  {`100.100.100.100:4444`, `dev.your-tailnet.ts.net:8444`} → DNS-rebinding blocked.
- **SSE constraint (build-time):** native `EventSource` CANNOT set a custom header.
  `/api/events` must move to a fetch-stream reader (ReadableStream) so the
  custom-header token applies uniformly. Do NOT pass the token via query param for
  SSE — that reintroduces CSRF and leaks the token into logs/referrers.

## Hardening (set-and-forget) — added per my call
- Constant-time token compare (`timingSafeEqual`).
- 256-bit CSPRNG tokens; enrollment codes single-use + TTL.
- **Brute-force throttle:** after N failed auths (per-IP, in-memory) → backoff/429.
  Tailnet single-user makes online guessing unlikely; the throttle neutralizes it
  regardless.
- **Security headers** on all responses: strict **CSP** (compensating control — the
  token is necessarily JS-readable, so CSP is what stops an XSS from exfiltrating it),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; HSTS on the HTTPS
  route.
- **Minimal auth-event log** (enroll / revoke / repeated-failure) to `data/` —
  observability so anomalies are visible without active monitoring. *[The one
  judgment-add; cut it if you want Build 0 leaner.]*

## Ceiling (honest bound — "more robust" is not infinite here)
The custom-header bearer design inherently leaves the token JS-readable in the PWA
(it must set the header). CSP mitigates but does not eliminate XSS-exfil. Exceeding
that ceiling means passkeys/WebAuthn (Option C) — deliberately deferred as
over-weight now. Build 0 is "as robust as a hardened bearer scheme gets"; the next
tier is a *different scheme*, not more effort.

**Considered switching to passkeys for the build-and-forget framing (2026-06-16) —
rejected.** The required CSRF/CORS/Host armor is *fixed regardless of identity
primitive*, because the threat is the authenticated browser tricked (CSRF/rebinding),
not an unauthenticated outsider — bearer, passkey, and Tailscale-identity all need it
on top. Given that, the identity layer should be the simplest robust thing that works
everywhere. Passkeys can't cover the raw `:4444` route at all (WebAuthn needs a secure
context + a registrable RP ID; a bare `http://IP:4444` has neither), forcing either
dropping that route or a bearer fallback anyway — and they add protocol surface that
rots, the opposite of forget-it-safely. They'd be the move only if Bifrost were ever
exposed beyond the tailnet (standing rule: never Funnel) or went multi-user. The
durable hardening of the bearer scheme's one weakness (token is JS-readable) is killed
at the source — strict CSP + render session content as text, never raw HTML — which
helps regardless of auth primitive.

## Explicitly NOT in Build 0 (boundary on "more robust")
- Passkeys / WebAuthn (Option C — future upgrade).
- Tailscale identity passthrough (Option B — no other users to distinguish).
- Token rotation / expiry-refresh machinery (minimal regenerate stays).
- Multi-user / roles / permissions (single-user tool).
- Encrypting the token store beyond 0600 (0600-as-the-user IS the trust boundary;
  encrypting just moves the key problem).

## Standing rules
- **NEVER Funnel Bifrost** — it stays tailnet-only, no public route, ever.
- Accepted residual: device compromise = full access (unavoidable for a personal tool).

## Verification (success criteria → tests)
- Unauthenticated request to any non-allowlisted endpoint → 401.
- Cross-origin request (forged Origin / no custom header) → rejected.
- Request with disallowed Host header → rejected (anti-rebinding).
- Bad / expired / revoked token → 401.
- Enrolled device with valid token → 200.
- Both routes (`:4444` and HTTPS) enforce identically.
- Token store unreadable → deny-all (fail closed), not open.
- Enrollment: valid one-time code → token issued; reused code → rejected; expired
  code → rejected.
- Brute-force: N rapid failures → 429/backoff.
- SSE reachable only with a token (fetch-stream, not `EventSource`).
- Auth/validation logic lives in pure, separately-tested modules (the
  `server/files/confine.ts` analog) — tested against forged Origins, bad Hosts, and
  malformed/timing-attack token inputs.

## As built (refinements discovered during the build — 2026-06-16)
- **Enrollment** = box-minted one-time code (disk-backed in `data/`, single-use +
  10-min TTL) → POST `/api/enroll` → per-device token. CLI: `bun run enroll` prints
  a code + terminal QR (QR encodes the HTTPS enroll URL with the code in the `#`
  fragment, so the code never hits server logs).
- **HSTS is gated by Host, not proto.** The `tailscale serve → caddy → :4444` chain
  rewrites `X-Forwarded-Proto`, so the server detects the HTTPS route by its
  (preserved) Host (`isSecureRequest`). HSTS verified present on HTTPS, absent on
  raw http.
- **Live-stream revocation** (`server/sse.ts`): the gate only covers new requests,
  so each SSE client is tagged with its token and the 25s heartbeat re-verifies it —
  a revoked device's open stream is cut within one beat. Unit-tested + live-verified.
- **Per-device ids + `revoke-id`** — labels collide (two `iPhone`s), so `list` shows
  an 8-char id and `revoke-id <id>` targets one device.
- **Enroll-failure throttling** — a bad enroll code also counts toward the per-IP
  brute-force throttle (codes are 96-bit so guessing is infeasible regardless).
- **Token lives in `localStorage`** (spec said IndexedDB) — equivalent XSS exposure;
  the real control is the strict CSP (`connect-src 'self'`) + react-markdown escaping
  HTML, both verified.

**Verified live (both routes):** unauth→401, forged Host→403, cross-origin→403,
enroll→token→200, bad/revoked token→401, reused code→400, throttle→429, HSTS on
HTTPS only, CSP/security headers present, SW does not cache `/api`, data files 0600,
XSS surface clean (no `dangerouslySetInnerHTML` / raw-HTML markdown).

## Gate
I greenlighted the locked spec (2026-06-16); built, reviewed, and converged same day.
