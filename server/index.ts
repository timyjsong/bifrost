import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { loadConfig, repoRoot } from "./config";
import { collectSessions } from "./collectors/sessions";
import {
  descendantsOf,
  leafChildren,
  deriveVia,
  nameFromCallIndex,
  settleStates,
  attributeBackground,
} from "./derive";
import { collectProjects } from "./collectors/projects";
import { collectSystem } from "./collectors/system";
import {
  summarizeSession,
  summarizeState,
  summarizeLimits,
} from "./summarize";
import {
  taskIdForPid,
  resolveTaskName,
  fullArgsForPid,
  fdLink,
  taskOwnerFromLink,
} from "./tasknames";
import { transcriptPathFor } from "./collectors/sessions";
import { sessionStream } from "./drive/live";
import { resolveTarget, liveTmuxSet } from "./drive/target";
import { sendText, sendKey } from "./drive/send";
import { getDraft, setDraft } from "./drive/drafts";
import { handleAlertRequest, evaluateAlerts } from "./alerts/manager";
import { handleFilesRequest } from "./files/handler";
import { mutedSessions } from "./alerts/sessions";
import { decide, isSecureRequest } from "./auth/guard";
import { verifyToken, mintToken } from "./auth/tokens";
import { consumeEnrollCode } from "./auth/enroll";
import { isThrottled, recordFailure } from "./auth/throttle";
import {
  addClient,
  removeClient,
  broadcast as sseBroadcast,
  sweep,
  type SSEClient,
} from "./sse";
import type { Snapshot, ProjectInfo } from "../shared/types";

const cfg = loadConfig();
const distDir = join(repoRoot, "web", "dist");

// ---- state ----------------------------------------------------------------

let snapshot: Snapshot = {
  generatedAt: 0,
  projects: [],
  sessions: [],
  system: {
    hostname: "",
    uptimeSec: 0,
    load: [0, 0, 0],
    disk: { totalKb: 0, freeKb: 0 },
    cores: 0,
    mem: { totalKb: 0, availKb: 0, swapTotalKb: 0, swapFreeKb: 0 },
    procs: [],
    claudeTotalRssKb: 0,
    tmux: [],
    ports: [],
  },
};
let projects: ProjectInfo[] = [];

let fastBusy = false;
async function fastTick() {
  if (fastBusy) return;
  fastBusy = true;
  try {
    const [sessRes, sysRes] = await Promise.all([
      collectSessions(cfg),
      collectSystem(),
    ]);
    // ps-tree descendants per live session
    const descByPidTree = new Map<number, Set<number>>();
    for (const s of sessRes.sessions) {
      if (s.live && s.pid) {
        descByPidTree.set(s.pid, descendantsOf(s.pid, sysRes.pidTree));
      }
    }
    // A live claude whose pid sits inside another live session's process tree is
    // spawned automation (claude-in-claude), whatever its entrypoint claims —
    // fold it in with the headless runs. Marked before attribution so it can't
    // be treated as an owner of its own siblings.
    for (const s of sessRes.sessions) {
      if (!s.live || !s.pid) continue;
      for (const [pid, desc] of descByPidTree) {
        if (pid !== s.pid && desc.has(s.pid)) {
          s.headless = true;
          break;
        }
      }
    }
    // Background work (run-in-background shells, fanned-out agents) reparents to
    // init the moment its launcher exits — gone from the process tree, but its
    // stdout fd still points at the owner's tasks/<uuid>/…/<id>.output. Read each
    // proc's task-dir UUID off that fd; attributeBackground maps it to the owning
    // session (learning the UUID from each session's own tree, since it can
    // differ from the sessionId) so orphans are captured and agents not double-
    // listed.
    const fdUuidByPid = new Map<number, string>();
    for (const p of sysRes.allProcs) {
      const link = fdLink(p.pid, 1);
      const owner = link ? taskOwnerFromLink(link) : undefined;
      if (owner) fdUuidByPid.set(p.pid, owner.ownerSessionId);
    }
    const { descByPid, absorbed } = attributeBackground(
      sessRes.sessions,
      descByPidTree,
      fdUuidByPid,
    );
    const ppidOf = new Map(sysRes.pidTree);
    const muted = await mutedSessions();
    for (const s of sessRes.sessions) {
      const sig = sessRes.signals.get(s.sessionId);
      if (!sig || !s.pid) continue;
      const descendants = descByPid.get(s.pid) ?? new Set();
      s.childProcs = descendants.size;
      s.children = leafChildren(descendants, sysRes.pidTree, sysRes.allProcs);
      for (const c of s.children) {
        // bg tasks: stdout fd -> tasks/<id>.output — on the leaf or any
        // ancestor inside this session's subtree (wrappers may redirect)
        let taskId: string | undefined;
        const chain: number[] = [];
        for (
          let p: number | undefined = c.pid;
          p !== undefined && descendants.has(p);
          p = ppidOf.get(p)
        ) {
          chain.push(p);
          taskId ??= taskIdForPid(p);
        }
        if (taskId) {
          c.name = await resolveTaskName(taskId, transcriptPathFor(s.sessionId));
        }
        // everything else: match the chain's full cmdlines (leaf first, then
        // its wrappers) against the session's rolling call index
        if (!c.name) {
          const texts = chain
            .map((p) => fullArgsForPid(p))
            .filter((t): t is string => !!t);
          c.name = nameFromCallIndex(texts, sig.callIndex);
        }
      }
      if (!s.headless) {
        const via = deriveVia(s.pid, sysRes.allProcs, sysRes.tmuxPanes);
        s.tmuxSession = via.tmuxSession;
        s.tmuxAttached = via.tmuxAttached;
        s.overSsh = via.overSsh;
      }
      s.alertsEnabled = !muted.has(s.sessionId); // per-card mute (default on)
      // NB: s.state is derived LATER — after attribution above — so a session
      // waiting on a re-attributed agent isn't misread as "awaiting".
    }
    // Derive live state ONLY now — s.childProcs finally reflects re-attributed
    // fan-out agents, so a session blocked on a background agent reads "paused",
    // not a false "awaiting"/needs-you. Same truth the alert layer's
    // genuinelyDone already used (it checks children); the card's state agrees.
    settleStates(sessRes.sessions, sessRes.signals);
    const sessions = sessRes.sessions.filter(
      (s) => !absorbed.has(s.sessionId),
    );
    let bundleId: number | undefined;
    try {
      bundleId = statSync(join(distDir, "index.html")).mtimeMs;
    } catch {
      // dist not built yet
    }
    snapshot = {
      generatedAt: Date.now(),
      bundleId,
      summarize: summarizeState(),
      projects,
      sessions,
      system: sysRes.info,
    };
    broadcastSnapshot(snapshot);
    // Derive alert signals from the same poll and push on policy-passing edges.
    // After broadcast so a source hiccup never delays the dashboard; robust on
    // its own, but caught here too — alerting must never disrupt the tick.
    await evaluateAlerts(sysRes.info, sessions, snapshot.generatedAt).catch((err) =>
      console.error("[bifrost] alert eval failed:", err),
    );
  } catch (err) {
    console.error("[bifrost] fast tick failed:", err);
  } finally {
    fastBusy = false;
  }
}

let slowBusy = false;
async function slowTick() {
  if (slowBusy) return;
  slowBusy = true;
  try {
    projects = await collectProjects(cfg, snapshot.sessions);
  } catch (err) {
    console.error("[bifrost] slow tick failed:", err);
  } finally {
    slowBusy = false;
  }
}

// ---- SSE ------------------------------------------------------------------
// Client registry, broadcast, and the revocation sweep live in ./sse (testable).

function broadcastSnapshot(snap: Snapshot) {
  sseBroadcast(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
}

function sseResponse(token: string | null): Response {
  let client: SSEClient;
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      client = {
        write: (chunk) => controller.enqueue(enc.encode(chunk)),
        close: () => {
          try {
            controller.close();
          } catch {
            // already closed
          }
        },
        token, // tagged so the heartbeat can drop it if the token is revoked
      };
      addClient(client);
      client.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    },
    cancel() {
      removeClient(client);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

// Heartbeat so proxies/browsers don't reap idle connections — and, on the same
// beat, cut any stream whose token has been revoked since it connected (bounds
// live-stream revocation latency to ~one heartbeat; the gate only covers new
// requests).
setInterval(() => {
  void sweep(verifyToken);
}, 25_000);

// ---- static ---------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

async function serveStatic(pathname: string): Promise<Response> {
  if (!existsSync(distDir)) {
    return new Response(
      "<!doctype html><title>Bifrost</title><body style=\"background:#0a0a0a;color:#e5e5e5;font-family:sans-serif\"><p>Bifrost API is up. Frontend not built yet — run <code>bun run build</code> in web/.</p>",
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  let rel = normalize(pathname).replace(/^\/+/, "");
  if (rel === "" || rel.includes("..")) rel = "index.html";
  let file = Bun.file(join(distDir, rel));
  if (!(await file.exists())) {
    file = Bun.file(join(distDir, "index.html")); // SPA fallback
  }
  const ext = rel.slice(rel.lastIndexOf("."));
  const immutable = rel.startsWith("assets/");
  return new Response(file, {
    headers: {
      "content-type": MIME[ext] ?? file.type ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    },
  });
}

// ---- security headers + CORS ----------------------------------------------

// Strict CSP. `connect-src 'self'` is the load-bearing control: even if an XSS
// ever slipped in, it could not exfiltrate the device token to another origin.
// `script-src 'self'` matches the single external module bundle (no inline JS);
// style needs 'unsafe-inline' for the inline <style> + runtime-injected styles.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

// The HTTPS route's Host (from the enroll URL). The tailscale-serve → caddy chain
// rewrites X-Forwarded-Proto but PRESERVES Host, so Host is the reliable "arrived
// over HTTPS" signal here — used to emit HSTS on that route.
const secureHost = (() => {
  try {
    return new URL(cfg.auth.enrollUrl).host;
  } catch {
    return "";
  }
})();

function secured(res: Response, origin: string | null, secure: boolean): Response {
  const h = res.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("Content-Security-Policy", CSP);
  if (secure) h.set("Strict-Transport-Security", "max-age=31536000");
  // CORS is defensive only — the PWA calls its own origin (relative paths). An
  // allowlisted Origin gets ACAO so the browser may read the response; anything
  // else gets none and is blocked.
  if (origin && cfg.auth.origins.includes(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin");
  }
  return res;
}

function preflight(origin: string | null): Response {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "X-Bifrost-Token, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  });
  if (origin && cfg.auth.origins.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return new Response(null, { status: 204, headers });
}

// ---- routing (reached only AFTER the auth gate admits the request) --------

async function route(req: Request, url: URL, now: number, ip: string): Promise<Response> {
  if (url.pathname === "/api/enroll" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      code?: unknown;
      label?: unknown;
    };
    const code = typeof body.code === "string" ? body.code : "";
    const label = typeof body.label === "string" ? body.label : "device";
    if (!(await consumeEnrollCode(code, now))) {
      recordFailure(ip, now); // a bad enroll code counts toward the throttle too
      return Response.json({ error: "invalid or expired code" }, { status: 400 });
    }
    const token = await mintToken(label, now);
    return Response.json({ token });
  }
  if (url.pathname === "/api/state") {
    return Response.json(snapshot);
  }
  const sumMatch = url.pathname.match(
    /^\/api\/sessions\/([0-9a-f-]{36})\/summarize$/,
  );
  if (sumMatch && req.method === "POST") {
    try {
      const result = await summarizeSession(cfg, sumMatch[1]);
      return Response.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message === "unknown session" ? 404 : 500;
      return Response.json({ error: message }, { status });
    }
  }
  if (url.pathname.startsWith("/api/push/") || url.pathname.startsWith("/api/alerts/")) {
    const res = await handleAlertRequest(req, url);
    if (res) return res;
  }
  if (url.pathname === "/api/files") {
    // Roots are the live project dirs — you can only browse INTO a project the
    // dashboard already shows, never the realm above it or anything outside.
    const res = await handleFilesRequest(url, projects.map((p) => p.path));
    if (res) return res;
  }
  if (url.pathname === "/api/events") {
    return sseResponse(req.headers.get("x-bifrost-token"));
  }
  // Per-session live drive stream (Build 1 / M2). The id is only a map key into
  // the collector's tracked sessions — it never touches the filesystem as a path,
  // so there's no traversal surface; an unknown session is a 404.
  const sessMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/events$/);
  if (sessMatch) {
    const sid = decodeURIComponent(sessMatch[1]);
    const tpath = transcriptPathFor(sid);
    if (!tpath) return new Response("no such session", { status: 404 });
    return sessionStream(sid, tpath, req.headers.get("x-bifrost-token"), verifyToken);
  }
  // Send a prompt into a session (Channel 2). The target is re-validated at send
  // time against the LIVE tmux set, so a non-injectable or vanished session fails
  // loud (409) rather than misdirecting. No content filter — "anything typeable".
  const promptMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/prompt$/);
  if (promptMatch && req.method === "POST") {
    const sid = decodeURIComponent(promptMatch[1]);
    const body = (await req.json().catch(() => ({}))) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) return Response.json({ ok: false, reason: "empty" }, { status: 400 });
    if (text.length > 100_000)
      return Response.json({ ok: false, reason: "too-long" }, { status: 413 });
    const sess = snapshot.sessions.find((s) => s.sessionId === sid);
    const tgt = resolveTarget(sess, liveTmuxSet(snapshot.system.tmux));
    if (!tgt.ok) return Response.json({ ok: false, reason: tgt.reason }, { status: 409 });
    try {
      await sendText(tgt.tmuxSession, text);
    } catch (err) {
      return Response.json(
        { ok: false, reason: "send-failed", detail: String((err as Error).message) },
        { status: 502 },
      );
    }
    await setDraft(sid, ""); // committed — clear the cross-device draft
    return Response.json({ ok: true });
  }
  // Interrupt a running turn (M4). Sends Esc — never Ctrl-C (which would exit the
  // session). The UI only exposes this while the session is working, so it can't
  // be mis-fired when there's nothing to stop.
  const interruptMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/interrupt$/);
  if (interruptMatch && req.method === "POST") {
    const sid = decodeURIComponent(interruptMatch[1]);
    const sess = snapshot.sessions.find((s) => s.sessionId === sid);
    const tgt = resolveTarget(sess, liveTmuxSet(snapshot.system.tmux));
    if (!tgt.ok) return Response.json({ ok: false, reason: tgt.reason }, { status: 409 });
    try {
      await sendKey(tgt.tmuxSession, "Escape");
    } catch {
      return Response.json({ ok: false, reason: "send-failed" }, { status: 502 });
    }
    return Response.json({ ok: true });
  }
  // Cross-device prompt draft: the uncommitted input buffer, server-side per
  // session so it follows the user across devices.
  const draftMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/draft$/);
  if (draftMatch) {
    const sid = decodeURIComponent(draftMatch[1]);
    if (req.method === "GET") return Response.json({ text: await getDraft(sid) });
    if (req.method === "PUT") {
      const body = (await req.json().catch(() => ({}))) as { text?: unknown };
      const text = typeof body.text === "string" ? body.text.slice(0, 100_000) : "";
      await setDraft(sid, text);
      return Response.json({ ok: true });
    }
  }
  if (url.pathname === "/api/health") {
    return Response.json({ ok: true, generatedAt: snapshot.generatedAt });
  }
  return serveStatic(url.pathname);
}

// ---- server ---------------------------------------------------------------

const server = Bun.serve({
  hostname: cfg.bind.host,
  port: cfg.bind.port,
  idleTimeout: 0, // SSE connections stay open
  async fetch(req, srv) {
    const url = new URL(req.url);
    const host = req.headers.get("host");
    const origin = req.headers.get("origin");
    const proto = req.headers.get("x-forwarded-proto");
    // The proxy chain rewrites X-Forwarded-Proto but preserves Host, so detect the
    // HTTPS route by its Host (HSTS rides on this).
    const secure = isSecureRequest(proto, host, secureHost);
    // Throttle key: the real socket address — unspoofable. On the HTTPS route that
    // is caddy, so HTTPS clients share one bucket; fine for a single-user tool.
    const ip = srv.requestIP(req)?.address ?? "unknown";
    const now = Date.now();

    // CORS preflight is answered before auth — the browser attaches no token to a
    // preflight, and refusing it (no ACAO for a bad origin) is what blocks CSRF.
    if (req.method === "OPTIONS") return preflight(origin);

    // Brute-force throttle on the auth surface.
    if (isThrottled(ip, now)) {
      return secured(
        Response.json({ error: "too many attempts" }, { status: 429 }),
        origin,
        secure,
      );
    }

    // The fail-closed gate — EVERY request passes here before any handler.
    // Default deny; the guard's tiny allowlist (static shell, /api/health,
    // /api/enroll) is the only way through without a valid device token.
    const tokenValid = await verifyToken(req.headers.get("x-bifrost-token"));
    const verdict = decide({
      pathname: url.pathname,
      host,
      origin,
      tokenValid,
      allowedHosts: cfg.auth.hosts,
      allowedOrigins: cfg.auth.origins,
    });
    if (!verdict.allow) {
      if (verdict.status === 401) recordFailure(ip, now);
      return secured(
        Response.json({ error: verdict.reason }, { status: verdict.status }),
        origin,
        secure,
      );
    }

    return secured(await route(req, url, now, ip), origin, secure);
  },
});

await fastTick(); // sessions first, so the project scan can attribute them
await slowTick();
await fastTick();
setInterval(fastTick, cfg.refresh.fastMs);
setInterval(slowTick, cfg.refresh.slowMs);

console.log(`[bifrost] watching from http://${server.hostname}:${server.port}`);
const lim = summarizeLimits(cfg);
console.log(
  `[bifrost] summarize: ${lim.maxInFlight} concurrent slots, ${lim.reserveMb}MB reserve floor ` +
    `(derived from ${(lim.totalMb / 1024).toFixed(1)}G box)`,
);
