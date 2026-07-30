import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, normalize } from "node:path";
import { homedir } from "node:os";
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
import { transcriptPathFor, transcriptMtimeFor, sessionIndexEntries } from "./collectors/sessions";
import { setSessionPin } from "./sessions/pins";
import { searchTranscriptsSerialized } from "./search/transcripts";
import { parseRewindMenu, rewindIndexByIdentity } from "./drive/rewind";
import { sessionDiff } from "./drive/diff";
import { sessionStream } from "./drive/live";
import { resolveTarget, liveTmuxSet } from "./drive/target";
import { sendText, sendKey, capturePane } from "./drive/send";
import { parseModelMenu, isModelConfirm, modelIndexByLabel } from "./drive/model";
import { parseEffortSlider, effortIndexByValue } from "./drive/effort";
import { runPickerRoute, type PaneIO } from "./drive/pickerRoute";
import { compileRoutes, matchRoute } from "./routes/table";
import { API, type RouteName } from "./routes/api";
import {
  readEffortLevel,
  restoreEffortLevel,
  shouldRestoreEffortDefault,
} from "./drive/effortDefault";
import {
  parsePermissionMenu,
  isValidAnswerKey,
  isPaneWorking,
  parsePermissionMode,
  modeFromPane,
  detectSignalDrift,
} from "./drive/menu";
import { slashFor } from "./drive/slash";
import { getDraft, setDraft } from "./drive/drafts";
import { clearSendFailure, recordSendFailure, sendFailure } from "./drive/sendFailures";
import { saveUpload, sweepUploads } from "./drive/uploads";
import { schedule as scheduleSend, cancel as cancelSend, isPending } from "./drive/scheduled";
import { heldWorking } from "./drive/workingHold";
import { capKills, decidePark } from "./lifecycle/park";
import {
  inflightJobFor,
  killForPark,
  logParkAction,
  markParked,
  queuedOpPending,
  readParkLog,
  readParked,
} from "./lifecycle/sweeper";
import { getSettings, setSettings, type Settings } from "./settings";
import { handleAlertRequest, evaluateAlerts } from "./alerts/manager";
import { collectAlertSources } from "./alerts/sources";
import { configureAlertSources } from "./alerts/sources";
import { setVapidSubject } from "./alerts/vapid";
import { handleFilesRequest, handleDirsRequest } from "./files/handler";
import { MAX_BODY_BYTES, exceedsBodyCap } from "./http";
import { mutedSessions } from "./alerts/sessions";
import { buildSpawnArgv, buildResumeArgv, assertBinaryExists, confineSpawnCwd, isAllowedModel, MODEL_ALLOWLIST } from "./spawn/spawn";
import { issueSpawn, readTranscriptCwd } from "./spawn/confirm";
import {
  PerUuidLock,
  bifrostTmuxLiveFresh,
  probeLiveByUuid,
  resumeSession,
} from "./spawn/resume";
import { decideRestart, confirmKilled, restartSession } from "./spawn/restart";
import { writePending, markActive, remove as removePending, reapRegistry } from "./spawn/registry";
import { decideMemoryGate, readSliceMemory, DEFAULT_BANDS } from "./spawn/memgate";
import {
  validateOriginateRequest,
  originateSession,
  isDriveable,
  type BadField,
} from "./spawn/originate";
import { decide, isSecureRequest, secureHostFrom } from "./auth/guard";
import { verifyToken, mintToken } from "./auth/tokens";
import { consumeEnrollCode } from "./auth/enroll";
import { throttleBlocks, recordFailure } from "./auth/throttle";
import { spawnLimited, recordSpawn } from "./auth/spawnLimit";
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
// Box-specific alert knobs come from config, not code (portability D).
configureAlertSources(cfg.alerts);
setVapidSubject(cfg.alerts.vapidSubject);

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

// Per-uuid resume lock (AC6.2 / REDTEAM M3): the whole check→claim→spawn→confirm
// runs under this; a concurrent same-uuid resume is rejected as "already starting"
// (409) rather than firing a second claude on the same transcript.
const resumeLock = new PerUuidLock();

let fastBusy = false;
async function fastTick() {
  if (fastBusy) return;
  fastBusy = true;
  try {
    const [sessRes, sysRes, alertSources] = await Promise.all([
      collectSessions(cfg),
      collectSystem(),
      // Collected once here and shared: surfaced in the snapshot (diagnostics)
      // AND handed to evaluateAlerts below (no double read). Guarded so an alert-
      // source hiccup can never abort the tick — the snapshot must still ship.
      collectAlertSources().catch((err) => {
        console.error("[bifrost] alert sources failed:", err);
        return undefined;
      }),
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
      diagnostics: alertSources,
    };
    broadcastSnapshot(snapshot);
    // Derive alert signals from the same poll and push on policy-passing edges.
    // After broadcast so a source hiccup never delays the dashboard; robust on
    // its own, but caught here too — alerting must never disrupt the tick.
    await evaluateAlerts(sysRes.info, sessions, snapshot.generatedAt, alertSources).catch((err) =>
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
    // Registry hygiene: drop rows whose crash-survival window has closed (the
    // session has a transcript, or is dead without one). Liveness reads the
    // tick snapshot — cheap, and drift tolerance here is minutes, not ms.
    const dropped = await reapRegistry({
      transcriptExists: (uuid) => !!transcriptPathFor(uuid),
      isLive: (uuid) =>
        snapshot.sessions.some((s) => s.sessionId === uuid && s.live) ||
        liveTmuxSet(snapshot.system.tmux).has(`bifrost-spawn-${uuid.replace(/-/g, "").slice(0, 8)}`),
    });
    if (dropped.length) console.log(`[bifrost] registry reaped: ${dropped.join(", ")}`);
    await sweepIdlePark();
  } catch (err) {
    console.error("[bifrost] slow tick failed:", err);
  } finally {
    slowBusy = false;
  }
}

// ---- idle-park sweeper (SESSION-LIFECYCLE-PLAN §3/§5/§8) --------------------
// Observe-only sessions are logged once per service run (the log must not fill
// with one idle session repeating every slow tick); kills always log.
const observedParkable = new Set<string>();
async function sweepIdlePark() {
  const now = Date.now();
  const jobsDir = join(cfg.claudeDir, "jobs");
  const candidates = snapshot.sessions.filter((s) => s.live && !s.headless);
  const verdicts = [];
  for (const s of candidates) {
    const uuid8 = s.sessionId.replace(/-/g, "").slice(0, 8);
    const bifrostSpawned = s.tmuxSession === `bifrost-spawn-${uuid8}`;
    // Cheap signals first; the transcript-tail queue check only for survivors.
    const base = decidePark(
      {
        live: s.live,
        bifrostSpawned,
        state: s.state ?? "",
        working: heldWorking(s.sessionId, false), // held reading; no fresh capture on the slow tick
        lastActivityAt: s.lastActivityAt,
        childProcs: s.childProcs ?? 0,
        hasInflightJob: false, // probed below only if otherwise eligible
        hasQueuedOp: false,
      },
      now,
      cfg.lifecycle,
    );
    if (!base.park) continue;
    // Expensive probes — only for otherwise-eligible sessions.
    if (inflightJobFor(s.sessionId, jobsDir)) continue;
    const tpath = transcriptPathFor(s.sessionId);
    if (tpath) {
      try {
        const fd = Bun.file(tpath);
        const size = fd.size;
        const tail = await fd.slice(Math.max(0, size - 65_536), size).text();
        if (queuedOpPending(tail)) continue;
      } catch {
        continue; // unreadable transcript — never park blind
      }
    }
    verdicts.push({ s, verdict: base });
  }
  for (const { s, verdict } of capKills(verdicts, cfg.lifecycle.maxKillsPerSweep)) {
    if (!verdict.park) continue;
    const idleMs = now - s.lastActivityAt;
    if (verdict.mode === "observe") {
      if (observedParkable.has(s.sessionId)) continue;
      observedParkable.add(s.sessionId);
      await logParkAction({ at: now, uuid: s.sessionId, mode: "observe", cwd: s.cwd, idleMs });
      continue;
    }
    if (!s.pid || !s.tmuxSession) continue;
    const parked = await killForPark({
      uuid: s.sessionId,
      pid: s.pid,
      tmuxSession: s.tmuxSession,
      killPane: async (name) => {
        const p = Bun.spawn(["tmux", "kill-session", "-t", `=${name}`], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        return await p.exited;
      },
    });
    await logParkAction({ at: now, uuid: s.sessionId, mode: "kill", cwd: s.cwd, idleMs });
    if (parked) {
      await markParked(s.sessionId, s.cwd, now);
      console.log(`[bifrost] idle-parked ${s.sessionId} (idle ${Math.round(idleMs / 60000)}m)`);
    }
  }
}

// ---- originate: drive-confirm (AC5.4) -------------------------------------
// A spawn that boot-confirms (transcript on disk + live pane) is NOT yet
// "driveable": the dashboard's session+tmux derivation runs on the fast tick, so
// the new session has no tmuxSession in `snapshot` until the next poll. AC5.4
// reports ready ONLY once resolveTarget resolves the new session — so after
// new-session we FORCE an out-of-band fastTick and poll isDriveable against the
// freshly-derived snapshot. Strictly stronger than boot-confirm.
async function confirmDriveable(
  sessionId: string,
  budgetMs: number,
  pollMs = 250,
): Promise<{ drivable: true; tmuxSession: string } | { drivable: false }> {
  const deadline = Date.now() + budgetMs;
  do {
    await fastTick(); // out-of-band refresh: re-derive sessions + re-collect tmux
    const sess = snapshot.sessions.find((s) => s.sessionId === sessionId);
    if (isDriveable(sess, liveTmuxSet(snapshot.system.tmux))) {
      return { drivable: true, tmuxSession: sess!.tmuxSession! };
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
  } while (Date.now() < deadline);
  return { drivable: false };
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
  // `data:` is required, not lax: Vite inlines small font files into the CSS
  // bundle as data URIs, and 'self' alone silently blocks them — the app renders
  // in a fallback face and only says so in the console. A font cannot execute,
  // so this costs nothing the way a `data:` script or frame would.
  "font-src 'self' data:",
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
const secureHost = secureHostFrom(cfg.auth.enrollUrl);

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

/**
 * The API surface, in order. Matching is `routes/table.ts` — first match wins,
 * a method mismatch falls through rather than 405-ing, and a param that fails
 * its `where` constraint falls through too, exactly as the old if-chain did.
 */
interface Ctx {
  req: Request;
  url: URL;
  now: number;
  ip: string;
  params: Record<string, string>;
}
type Handler = (c: Ctx) => Promise<Response>;

/**
 * One handler per declared route. The Record type is exhaustive over RouteName,
 * so a route added to routes/api.ts without a handler here fails to compile.
 */
const HANDLERS: Record<RouteName, Handler> = {
  enroll: async ({ req, now, ip }) => {
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
  },
  state: async (_c) => {
    return Response.json(snapshot);
  },
  sessionIndex: async (_c) => {
    const liveIds = new Set(
      snapshot.sessions.filter((s) => s.live).map((s) => s.sessionId),
    );
    return Response.json({ entries: sessionIndexEntries(liveIds) });
  },
  sessionsPin: async ({ req }) => {
    const body = (await req.json().catch(() => null)) as
      | { sessionId?: string; pinned?: boolean }
      | null;
    if (!body?.sessionId || typeof body.pinned !== "boolean") {
      return Response.json({ error: "sessionId + pinned required" }, { status: 400 });
    }
    await setSessionPin(body.sessionId, body.pinned);
    return Response.json({ ok: true });
  },
  summarize: async ({ params }) => {
    try {
      const result = await summarizeSession(cfg, params.id);
      return Response.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message === "unknown session" ? 404 : 500;
      return Response.json({ error: message }, { status });
    }
  },
  files: async ({ url }) => {
    // Roots are the live project dirs — you can only browse INTO a project the
    // dashboard already shows, never the realm above it or anything outside.
    const res = await handleFilesRequest(url, projects.map((p) => p.path));
    if (res) return res;
    return serveStatic(url.pathname); // declined — fall through, as before
  },
  dirs: async ({ url }) => {
    // The originate picker's directory browser — home-rooted, the same bound
    // the spawn cwd guard enforces on the chosen folder.
    const res = await handleDirsRequest(url, homedir());
    if (res) return res;
    return serveStatic(url.pathname); // declined — fall through, as before
  },
  events: async ({ req }) => {
    return sseResponse(req.headers.get("x-bifrost-token"));
  },
  sessionEvents: async ({ req, url, params }) => {
    const sid = params.id;
    // A freshly spawned session has no transcript until its first turn — it is
    // still a real, driveable session (surfaced via its pid-file), so the
    // stream opens with an empty state and adopts the file when it appears.
    const known =
      !!transcriptPathFor(sid) || snapshot.sessions.some((s) => s.sessionId === sid);
    if (!known) return new Response("no such session", { status: 404 });
    // Resumable reconnect: the client passes ?since=<message count> it already
    // holds so the stream ships only the delta, not the whole transcript. A
    // bogus/oversized value is safe — the reader falls back to a full "state".
    const since = Number(url.searchParams.get("since")) || 0;
    return sessionStream(
      sid,
      () => transcriptPathFor(sid),
      req.headers.get("x-bifrost-token"),
      verifyToken,
      undefined,
      undefined,
      since,
    );
  },
  prompt: async ({ req, params }) => {
    const sid = params.id;
    const body = (await req.json().catch(() => ({}))) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) return Response.json({ ok: false, reason: "empty" }, { status: 400 });
    if (text.length > 100_000)
      return Response.json({ ok: false, reason: "too-long" }, { status: 413 });
    // Validate injectability NOW so an undrivable session fails loud immediately
    // (409) rather than silently never firing. It's RE-resolved at fire time too
    // — a session that dies during the grace window simply doesn't fire.
    const sess = snapshot.sessions.find((s) => s.sessionId === sid);
    const tgt = resolveTarget(sess, liveTmuxSet(snapshot.system.tmux));
    if (!tgt.ok) return Response.json({ ok: false, reason: tgt.reason }, { status: 409 });
    // Park the send for the grace period; a cancel within the window aborts it.
    // The server owns the timer, so closing the app inside the window still fires.
    const { sendDelayMs } = await getSettings();
    clearSendFailure(sid); // a fresh attempt supersedes any stale failure record
    const { fireAt } = scheduleSend(sid, sendDelayMs, async () => {
      // Re-resolve against the LIVE tmux set at fire time (seconds later — the
      // session may have moved or died). A failed fire is RECORDED, never
      // swallowed: the draft endpoint carries it to every polling device, which
      // drops its optimistic echo and restores the (still-uncleared) draft text.
      const s = snapshot.sessions.find((x) => x.sessionId === sid);
      const t = resolveTarget(s, liveTmuxSet(snapshot.system.tmux));
      // On failure, park the unsent text back into the cross-device draft (when
      // the user hasn't typed a newer one) — the client's restore reads from
      // there, and the 500ms draft debounce means a fast type-and-submit may
      // never have persisted the text at all.
      const failKeepingText = async (reason: string) => {
        recordSendFailure(sid, reason);
        if (!(await getDraft(sid))) await setDraft(sid, text);
      };
      if (!t.ok) {
        await failKeepingText(t.reason);
        return;
      }
      try {
        await sendText(t.tmuxSession, text);
        await setDraft(sid, ""); // committed — clear the cross-device draft
        clearSendFailure(sid);
      } catch {
        await failKeepingText("send-error");
      }
    });
    return Response.json({ ok: true, delayMs: sendDelayMs, fireAt });
  },
  promptCancel: async ({ params }) => {
    const sid = params.id;
    return Response.json({ ok: true, cancelled: cancelSend(sid) });
  },
  interrupt: async ({ params }) => {
    const sid = params.id;
    const sess = snapshot.sessions.find((s) => s.sessionId === sid);
    const tgt = resolveTarget(sess, liveTmuxSet(snapshot.system.tmux));
    if (!tgt.ok) return Response.json({ ok: false, reason: tgt.reason }, { status: 409 });
    try {
      await sendKey(tgt.tmuxSession, "Escape");
    } catch {
      return Response.json({ ok: false, reason: "send-failed" }, { status: 502 });
    }
    return Response.json({ ok: true });
  },
  pane: async ({ now, params }) => {
    const sid = params.id;
    const sess = snapshot.sessions.find((s) => s.sessionId === sid);
    const tgt = resolveTarget(sess, liveTmuxSet(snapshot.system.tmux));
    if (!tgt.ok)
      return Response.json({
        drivable: false,
        menu: null,
        raw: "",
        working: false,
        pendingSend: false,
        mode: null,
        drift: [],
      });
    let raw = "";
    try {
      raw = await capturePane(tgt.tmuxSession);
    } catch {
      /* pane vanished between resolve and capture */
    }
    const tail = raw.split("\n").filter((l) => l.trim()).slice(-30).join("\n");
    return Response.json({
      drivable: true,
      menu: parsePermissionMenu(raw),
      raw: tail,
      // Held: one blank capture frame mid-turn must not flip send-gating open.
      working: heldWorking(sid, isPaneWorking(raw)),
      // Backstop: pass how long the transcript has been idle so a stuck "working"
      // timer over a long-dead transcript surfaces as drift.
      drift: detectSignalDrift(
        raw,
        transcriptMtimeFor(sid) !== undefined ? now - transcriptMtimeFor(sid)! : undefined,
      ),
      // a send parked server-side (this device's grace window OR another device's)
      // → every polling device disables send for the whole in-flight window.
      pendingSend: isPending(sid),
      // Readable pane + no mode string = the default mode (the current TUI
      // renders nothing for it); an empty capture stays null (unknown).
      mode: modeFromPane(raw),
    });
  },
  mode: async ({ req, params }) => {
    const sid = params.id;
    const body = (await req.json().catch(() => ({}))) as { mode?: unknown };
    const target = body.mode;
    if (target !== "auto" && target !== "accept-edits" && target !== "plan")
      return Response.json({ ok: false, reason: "bad-mode" }, { status: 400 });
    const sess = snapshot.sessions.find((s) => s.sessionId === sid);
    const tgt = resolveTarget(sess, liveTmuxSet(snapshot.system.tmux));
    if (!tgt.ok) return Response.json({ ok: false, reason: tgt.reason }, { status: 409 });
    let raw = "";
    try {
      raw = await capturePane(tgt.tmuxSession);
    } catch {
      /* pane vanished */
    }
    // The current TUI renders NOTHING for the default mode (verified live
    // 2026-07-02: accept-edits/plan strings unchanged, default = bare bar) —
    // an unparsable pane at this seam means "default", not "unreadable".
    let cur = parsePermissionMode(raw) ?? "auto";
    // Closed loop: press Shift+Tab once, re-read the pane, repeat until the mode
    // matches. Robust against the TUI occasionally dropping a rapid press (an
    // open-loop count of presses proved flaky). Bounded so it can never spin.
    try {
      for (let tries = 0; cur !== target && tries < 6; tries++) {
        await sendKey(tgt.tmuxSession, "BTab"); // Shift+Tab
        await new Promise((r) => setTimeout(r, 300)); // let Ink redraw
        cur = parsePermissionMode(await capturePane(tgt.tmuxSession)) ?? "auto";
      }
    } catch {
      return Response.json({ ok: false, reason: "send-failed" }, { status: 502 });
    }
    if (cur !== target)
      return Response.json({ ok: false, reason: "mode-switch-failed", mode: cur }, { status: 502 });
    return Response.json({ ok: true, mode: cur });
  },
  answer: async ({ req, params }) => {
    const sid = params.id;
    const body = (await req.json().catch(() => ({}))) as { key?: unknown };
    const key = typeof body.key === "string" ? body.key : "";
    if (!isValidAnswerKey(key))
      return Response.json({ ok: false, reason: "bad-key" }, { status: 400 });
    const sess = snapshot.sessions.find((s) => s.sessionId === sid);
    const tgt = resolveTarget(sess, liveTmuxSet(snapshot.system.tmux));
    if (!tgt.ok) return Response.json({ ok: false, reason: tgt.reason }, { status: 409 });
    try {
      await sendKey(tgt.tmuxSession, key);
    } catch {
      return Response.json({ ok: false, reason: "send-failed" }, { status: 502 });
    }
    return Response.json({ ok: true });
  },
  capture: async ({ params }) => {
    const sid = params.id;
    const sess = snapshot.sessions.find((s) => s.sessionId === sid);
    const tgt = resolveTarget(sess, liveTmuxSet(snapshot.system.tmux));
    if (!tgt.ok) return Response.json({ text: "" });
    let text = "";
    try {
      text = await capturePane(tgt.tmuxSession, { escapes: true });
    } catch {
      /* pane vanished */
    }
    return Response.json({ text });
  },
  slash: async ({ now, params }) => {
    const sid = params.id;
    const sess = snapshot.sessions.find((s) => s.sessionId === sid);
    if (!sess) return Response.json({ commands: [] });
    return Response.json({ commands: await slashFor(cfg.claudeDir, sess.cwd, now) });
  },
  diff: async ({ params }) => {
    const sid = params.id;
    const sess = snapshot.sessions.find((s) => s.sessionId === sid);
    if (!sess?.cwd) return Response.json({ git: false });
    const d = await sessionDiff(sess.cwd, async (argv, cwd) => {
      // Bun.spawn throws ENOENT synchronously if cwd no longer exists (a deleted
      // project dir). Treat any spawn failure as a non-git result so the client
      // degrades to "no diff" instead of the route 500-ing.
      try {
        const p = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
        const stdout = await new Response(p.stdout).text();
        return { code: await p.exited, stdout };
      } catch {
        return { code: 128, stdout: "" };
      }
    });
    return Response.json(d);
  },
  rewind: async ({ req, params }) => {
    const sid = params.id;
    const action = params.action;
    const sess = snapshot.sessions.find((s) => s.sessionId === sid);
    const tgt = resolveTarget(sess, liveTmuxSet(snapshot.system.tmux));
    if (!tgt.ok) return Response.json({ ok: false, reason: tgt.reason }, { status: 409 });
    const target = tgt.tmuxSession;
    // Esc-Esc is the rewind gesture; the two presses need a beat between them.
    const openSpec = {
      trigger: async (t: string, io: PaneIO) => {
        await io.key(t, "Escape");
        await io.sleep(350);
        await io.key(t, "Escape");
      },
      parse: parseRewindMenu,
    };
    return runPickerRoute({
      sessionId: sid,
      target,
      action,
      req,
      openSpec,
      drive: {
        parse: parseRewindMenu,
        count: (m) => m.checkpoints.length,
        cursor: (m) => m.cursorIndex,
        navKeys: ["Up", "Down"],
      },
      choice: (body) => {
        const b = body as { label?: unknown; detail?: unknown };
        return typeof b.label === "string" && typeof b.detail === "string"
          ? { label: b.label, detail: b.detail }
          : null;
      },
      // Resolve by IDENTITY, not the peek-time index: the list can have grown
      // since the peek, and rewind is destructive, so a stale index must never
      // restore the wrong point. Ambiguous matches refuse too (see rewind.ts).
      locate: (menu, id) => rewindIndexByIdentity(menu.checkpoints, id),
      // The numbered confirm that follows arrives through the NORMAL pane poll
      // (parsePermissionMenu handles it) and is answered via the /answer route.
      confirm: async ({ target: t, io }) => {
        await io.key(t, "Enter");
        return Response.json({ ok: true });
      },
      stuckReason: "cursor-stuck",
    });
  },
  model: async ({ req, params }) => {
    const sid = params.id;
    const action = params.action;
    const sess = snapshot.sessions.find((s) => s.sessionId === sid);
    const tgt = resolveTarget(sess, liveTmuxSet(snapshot.system.tmux));
    if (!tgt.ok) return Response.json({ ok: false, reason: tgt.reason }, { status: 409 });
    const target = tgt.tmuxSession;
    return runPickerRoute({
      sessionId: sid,
      target,
      action,
      req,
      openSpec: {
        trigger: (t, io) => io.text(t, "/model"), // sendText clears residual input
        parse: parseModelMenu,
      },
      drive: {
        parse: parseModelMenu,
        count: (m) => m.options.length,
        cursor: (m) => m.cursorIndex,
        navKeys: ["Up", "Down"],
      },
      choice: (body) => {
        const b = body as { label?: unknown };
        return typeof b.label === "string" ? b.label : null;
      },
      // By LABEL, not the peek-time index — the offered list can shift.
      locate: (menu, label) => modelIndexByLabel(menu.options, label),
      // THE CONTRACT: confirm with "s" (this session only). Enter here would
      // persist the pick as the ACCOUNT default, which Bifrost must never touch.
      // Then answer the cache-cost "Switch model?" dialog that follows.
      confirm: async ({ target: t, io, budget }) => {
        await io.key(t, "s");
        await io.sleep(400);
        while (budget.left > 0) {
          budget.left--;
          const raw = await io.capture(t);
          if (isModelConfirm(raw)) {
            await io.key(t, "1"); // Yes, switch
            await io.sleep(400);
            continue;
          }
          if (!parseModelMenu(raw)) return Response.json({ ok: true }); // picker gone
          await io.sleep(300);
        }
        return Response.json({ ok: false, reason: "confirm-stuck" }, { status: 502 });
      },
      stuckReason: "confirm-stuck",
    });
  },
  effort: async ({ req, params }) => {
    const sid = params.id;
    const action = params.action;
    const sess = snapshot.sessions.find((s) => s.sessionId === sid);
    const tgt = resolveTarget(sess, liveTmuxSet(snapshot.system.tmux));
    if (!tgt.ok) return Response.json({ ok: false, reason: tgt.reason }, { status: 409 });
    const target = tgt.tmuxSession;
    return runPickerRoute({
      sessionId: sid,
      target,
      action,
      req,
      openSpec: {
        trigger: (t, io) => io.text(t, "/effort"), // sendText clears residual input
        parse: parseEffortSlider,
        unsupported: /not supported/i,
      },
      drive: {
        parse: parseEffortSlider,
        count: (s) => s.options.length,
        cursor: (s) => s.currentIndex,
        navKeys: ["Left", "Right"],
      },
      choice: (body) => {
        const b = body as { value?: unknown };
        return typeof b.value === "string" ? b.value : null;
      },
      locate: (slider, value) => effortIndexByValue(slider.options, value),
      // The confirm latches the SESSION's effort but ALSO side-writes the account
      // default ("saved as your default for new sessions") — verified live.
      // Bifrost's control is session-scoped: restore the default we read
      // beforehand iff the write was ours (see drive/effortDefault.ts).
      confirm: async ({ target: t, io, picker, index }) => {
        const prior = await readEffortLevel(cfg.claudeDir);
        await io.key(t, "Enter");
        await io.sleep(800);
        const after = await readEffortLevel(cfg.claudeDir);
        if (shouldRestoreEffortDefault(prior, after, picker.options[index])) {
          await restoreEffortLevel(cfg.claudeDir, prior!);
        }
        return Response.json({ ok: true });
      },
      stuckReason: "cursor-stuck",
    });
  },
  search: async ({ url }) => {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q.length < 3) return Response.json({ hits: [] });
    const hits = await searchTranscriptsSerialized(q, {
      projectsDir: join(cfg.claudeDir, "projects"),
    });
    return Response.json({ hits });
  },
  draft: async ({ req, url, params }) => {
    const sid = params.id;
    if (req.method === "GET")
      return Response.json({ text: await getDraft(sid), sendFailure: sendFailure(sid) });
    if (req.method === "PUT") {
      const body = (await req.json().catch(() => ({}))) as { text?: unknown };
      const text = typeof body.text === "string" ? body.text.slice(0, 100_000) : "";
      await setDraft(sid, text);
      return Response.json({ ok: true });
    }
    return serveStatic(url.pathname); // unreachable: method is constrained
  },
  upload: async ({ req, now, params }) => {
    const sid = params.id;
    const form = await req.formData().catch(() => null);
    if (!form) return Response.json({ ok: false, reason: "bad-form" }, { status: 400 });
    await sweepUploads(now); // TTL-clean older uploads whenever a new one lands
    const files: { path: string; name: string }[] = [];
    for (const value of form.getAll("file")) {
      if (!(value instanceof File)) continue;
      if (value.size > 25 * 1024 * 1024) continue; // 25MB cap — skip oversized
      const bytes = new Uint8Array(await value.arrayBuffer());
      const saved = await saveUpload(sid, value.name, bytes);
      files.push({ path: saved.path, name: value.name }); // show the original name; path stays unique
    }
    return Response.json({ ok: true, files });
  },
  lifecyclePark: async (_c) => {
    const [entries, parked] = await Promise.all([readParkLog(50), readParked()]);
    return Response.json({
      enabled: cfg.lifecycle.enabled,
      idleParkMs: cfg.lifecycle.idleParkMs,
      entries,
      parkedCount: Object.keys(parked).length,
    });
  },
  settings: async ({ req, url }) => {
    if (req.method === "GET") return Response.json(await getSettings());
    if (req.method === "PUT") {
      const body = (await req.json().catch(() => ({}))) as Partial<Settings>;
      return Response.json(await setSettings(body));
    }
    return serveStatic(url.pathname); // unreachable: method is constrained
  },
  originate: async ({ req, now, ip }) => {
    // Resource guard: cap NEW-process spawns per window (a leaked/shared token
    // or runaway client must not storm the box). Not an auth decision — a cost
    // ceiling; single-user tailnet installs never reach it.
    if (spawnLimited(ip, now))
      return Response.json({ ok: false, reason: "rate-limited" }, { status: 429 });
    recordSpawn(ip, now);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const valid = validateOriginateRequest(body);
    if (!valid.ok) {
      return Response.json({ ok: false, reason: valid.reason }, { status: 400 });
    }
    // The cwd carries RCE weight (it picks WHERE a promptable claude runs), so it
    // gets the same canonicalizing confinement the file browser uses — symlink/`..`
    // escapes out of the home root are rejected here as a 400 (AC5.1/AC5.5).
    const confined = await confineSpawnCwd(valid.value.cwd);
    if (!confined.ok) {
      const reason: BadField = "bad-cwd";
      return Response.json({ ok: false, reason, detail: confined.reason }, { status: 400 });
    }
    const req5 = { ...valid.value, cwd: confined.path };
    const uuid = randomUUID();
    const projectsDir = join(cfg.claudeDir, "projects");
    const sessionsDir = join(cfg.claudeDir, "sessions");

    const outcome = await originateSession(uuid, req5, {
      // 2-4 memory gate over the live shared-slice reading. An uncapped or
      // unreadable slice (max=0) falls back to the SYSTEM memory budget so a
      // stock host without a per-user MemoryMax isn't blocked from every spawn.
      gate: async () => {
        const reading = (await readSliceMemory()) ?? { current: 1, max: 0 };
        const sys = snapshot.system.mem;
        return decideMemoryGate(reading, [], DEFAULT_BANDS, {
          totalKb: sys.totalKb,
          availKb: sys.availKb,
        });
      },
      writePending,
      // The spawn issuer composes the 2-3 pure layer (argv + binary assertion) with
      // the impure executor (issueSpawn). It makes no security decision of its own.
      issueSpawn: async (id, cwd, model) => {
        assertBinaryExists(cfg.claudeBin); // pre-spawn: binary must exist, or throw loudly
        const argv = buildSpawnArgv({ uuid: id, model, cwd, claudeBin: cfg.claudeBin });
        return issueSpawn(argv, id, cwd, { projectsDir, sessionsDir, timeoutMs: 15_000, pollMs: 250 });
      },
      markActive,
      remove: removePending,
    });

    if (!outcome.ok) {
      if (outcome.reason === "blocked") {
        return Response.json(
          { ok: false, reason: "memory-blocked", message: outcome.message },
          { status: 409 },
        );
      }
      return Response.json(
        { ok: false, reason: "spawn-failed", detail: outcome.detail },
        { status: 502 },
      );
    }

    // Boot-confirmed. Now DRIVE-confirm (AC5.4): force an out-of-band refresh and
    // poll resolveTarget until the new session is actually driveable.
    const drive = await confirmDriveable(uuid, 5_000);
    return Response.json({
      ok: true,
      sessionId: uuid,
      tmuxSession: outcome.tmuxSession,
      caution: outcome.caution,
      driveable: drive.drivable,
    });
  },
  resume: async ({ now, ip, params }) => {
    if (spawnLimited(ip, now))
      return Response.json({ ok: false, reason: "rate-limited" }, { status: 429 });
    recordSpawn(ip, now);
    const uuid = params.id;
    const projectsDir = join(cfg.claudeDir, "projects");
    const sessionsDir = join(cfg.claudeDir, "sessions");

    const locked = await resumeLock.run(uuid, async () => {
      // All three not-live signals read FRESH at click time (AC6.1) — never the
      // ≤3s tick snapshot. The Bifrost-owned tmux name is what a resume/originate
      // lands under, so its presence means this uuid already has a pane.
      const tpath = transcriptPathFor(uuid);
      const tmuxLive = await bifrostTmuxLiveFresh(uuid);

      return resumeSession(uuid, {
        // Fresh live probe at click time (AC6.1 / H4) — re-scans the sessions dir
        // and /proc with the procStart reuse guard, never the snapshot.
        probe: () => probeLiveByUuid(uuid, { sessionsDir }),
        bifrostTmuxLive: () => tmuxLive,
        transcriptMtime: () => transcriptMtimeFor(uuid),
        // Read the transcript's OWN cwd (the slug is lossy — never reverse it).
        readBackCwd: () => (tpath ? readTranscriptCwd(tpath) : Promise.resolve(undefined)),
        // Existence check only — NO realm confine (AC6.5): any dir resumes.
        cwdExists: async (cwd) => existsSync(cwd),
        issueResume: async (id, cwd) => {
          assertBinaryExists(cfg.claudeBin); // pre-spawn: binary must exist, or throw loudly
          const argv = buildResumeArgv({ uuid: id, cwd, claudeBin: cfg.claudeBin });
          return issueSpawn(argv, id, cwd, { projectsDir, sessionsDir, timeoutMs: 15_000, pollMs: 250 });
        },
        now: () => Date.now(),
      });
    });

    if (!locked.ok) {
      // Lock held by a concurrent same-uuid resume (AC6.2 / M3).
      return Response.json({ ok: false, reason: "already-starting" }, { status: 409 });
    }
    const outcome = locked.value;
    if (outcome.ok) {
      // Boot-confirmed. Drive-confirm so the client can open the live drive view at
      // once (mirrors originate's AC5.4 out-of-band refresh).
      const drive = await confirmDriveable(uuid, 5_000);
      return Response.json({
        ok: true,
        sessionId: uuid,
        tmuxSession: outcome.tmuxSession,
        driveable: drive.drivable,
      });
    }
    switch (outcome.reason) {
      case "already-live":
        // AC6.3 — route to drive, never a second claude. The client opens the
        // existing live session rather than spawning.
        return Response.json({ ok: false, reason: "already-live", route: "drive" }, { status: 409 });
      case "degraded-cwd-missing":
        return Response.json(
          { ok: false, reason: "degraded", detail: "cwd missing", cwd: outcome.cwd },
          { status: 422 },
        );
      case "degraded-cwd-unreadable":
        return Response.json(
          { ok: false, reason: "degraded", detail: "cwd unreadable" },
          { status: 422 },
        );
      case "not-resumable":
        return Response.json(
          { ok: false, reason: "not-resumable", detail: outcome.detail },
          { status: 409 },
        );
      default:
        return Response.json(
          { ok: false, reason: "spawn-failed", detail: outcome.detail },
          { status: 502 },
        );
    }
  },
  restart: async ({ req, now, ip, params }) => {
    if (spawnLimited(ip, now))
      return Response.json({ ok: false, reason: "rate-limited" }, { status: 429 });
    recordSpawn(ip, now);
    const uuid = params.id;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    // AC7.1 — confirm-before-kill gate. No confirm ⇒ 428 (precondition: confirm
    // required); a bad mode ⇒ 400. Neither issues a kill.
    const gate = decideRestart(body);
    if (!gate.proceed) {
      const status = gate.reason === "bad-mode" ? 400 : 428;
      return Response.json({ ok: false, reason: gate.reason }, { status });
    }
    const mode = gate.mode;

    const projectsDir = join(cfg.claudeDir, "projects");
    const sessionsDir = join(cfg.claudeDir, "sessions");

    const locked = await resumeLock.run(uuid, async () => {
      // Resolve the live tmux pane to kill from the FRESH snapshot derivation (the
      // session's actual tmux name — Claude- or Bifrost-originated). An undrivable /
      // already-dead session can't be restarted: surface session-gone.
      const sess = snapshot.sessions.find((s) => s.sessionId === uuid);
      const tgt = resolveTarget(sess, liveTmuxSet(snapshot.system.tmux));
      if (!tgt.ok) return { ok: false as const, reason: "session-gone" as const };
      const killName = tgt.tmuxSession;
      const tpath = transcriptPathFor(uuid);
      // The relaunch model for a fresh-restart: the dead session's own when it's on
      // the allowlist, else opus (a clean conversation needs a pinned --model).
      const relaunchModel =
        sess?.model && isAllowedModel(sess.model) ? sess.model : MODEL_ALLOWLIST[0];

      return restartSession(uuid, mode, {
        // AC7.2 — confirmed-dead by DIRECT probes, never the snapshot. Kill the live
        // pane, then poll a FRESH /proc-gone read (probeLiveByUuid re-scans the
        // sessions dir + /proc with the procStart reuse guard) AND a fresh
        // tmux has-session, until both report gone — then relaunch.
        confirmKilled: () =>
          confirmKilled({
            killSession: async () => {
              const p = Bun.spawn(["tmux", "kill-session", "-t", `=${killName}`], {
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              });
              return await p.exited;
            },
            // FRESH /proc read per poll: probeLiveByUuid re-scans the sessions dir +
            // /proc with the procStart reuse guard. A live pid still referencing the
            // uuid ⇒ the process is still draining; never relaunch onto it.
            procAlive: async () => (await probeLiveByUuid(uuid, { sessionsDir })).livePid !== null,
            // FRESH tmux probe per poll against the KILLED pane's OWN name (the
            // session's actual tmux name, Claude- or Bifrost-originated — not a guessed
            // Bifrost name). The pane is gone only when has-session fails (rc≠0).
            tmuxLive: async () => {
              const p = Bun.spawn(["tmux", "has-session", "-t", `=${killName}`], {
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              });
              return (await p.exited) === 0;
            },
            timeoutMs: 10_000,
            pollMs: 250,
          }),
        // Both modes relaunch in the dead session's OWN cwd (read back from its
        // transcript head — the slug is lossy, never reversed).
        readBackCwd: () =>
          tpath ? readTranscriptCwd(tpath) : Promise.resolve(undefined),
        // AC7.3 resume mode — `--resume <uuid>`, same conversation.
        issueResume: async (id, cwd) => {
          assertBinaryExists(cfg.claudeBin);
          const argv = buildResumeArgv({ uuid: id, cwd, claudeBin: cfg.claudeBin });
          return issueSpawn(argv, id, cwd, { projectsDir, sessionsDir, timeoutMs: 15_000, pollMs: 250 });
        },
        // AC7.3 fresh mode — a NEW --session-id in the SAME cwd; the relaunch model
        // is the dead session's own (fallback opus) since fresh starts a clean
        // conversation. The OLD transcript is never deleted.
        issueFresh: async (newId, cwd) => {
          assertBinaryExists(cfg.claudeBin);
          const argv = buildSpawnArgv({ uuid: newId, model: relaunchModel, cwd, claudeBin: cfg.claudeBin });
          // Registry lifecycle for the NEW conversation — same contract as
          // originate (pending before spawn, active on confirm, gone on fail);
          // its transcript-less boot window deserves the same crash survival.
          await writePending(newId, { cwd, label: "", spawnReason: "restart-fresh" });
          const r = await issueSpawn(argv, newId, cwd, { projectsDir, sessionsDir, timeoutMs: 15_000, pollMs: 250 });
          if (r.ok) await markActive(newId);
          else await removePending(newId);
          return r;
        },
        newUuid: () => randomUUID(),
      });
    });

    if (!locked.ok) {
      // The per-uuid lock is held by a concurrent restart/resume on this uuid.
      return Response.json({ ok: false, reason: "already-starting" }, { status: 409 });
    }
    const outcome = locked.value;
    if (outcome.ok) {
      // Boot-confirmed. Drive-confirm so the client can open the live drive view at
      // once (mirrors resume/originate's out-of-band refresh). The conversation now
      // live is outcome.uuid (the SAME uuid on resume, the NEW one on fresh).
      const drive = await confirmDriveable(outcome.uuid, 5_000);
      return Response.json({
        ok: true,
        mode: outcome.mode,
        sessionId: outcome.uuid,
        tmuxSession: outcome.tmuxSession,
        driveable: drive.drivable,
      });
    }
    switch (outcome.reason) {
      case "session-gone":
        return Response.json({ ok: false, reason: "session-gone" }, { status: 409 });
      case "kill-refused":
        return Response.json(
          { ok: false, reason: "kill-refused", rc: outcome.rc },
          { status: 502 },
        );
      case "still-alive":
        return Response.json({ ok: false, reason: "still-alive" }, { status: 504 });
      case "cwd-unreadable":
        return Response.json(
          { ok: false, reason: "degraded", detail: "cwd unreadable" },
          { status: 422 },
        );
      case "spawn-failed":
        return Response.json(
          { ok: false, reason: "spawn-failed", detail: outcome.detail },
          { status: 502 },
        );
      default:
        // unconfirmed / bad-mode are gated BEFORE the lock (decideRestart), so the
        // orchestration never returns them here — this is an unreachable safety net.
        return Response.json({ ok: false, reason: "spawn-failed" }, { status: 502 });
    }
  },
  health: async (_c) => {
    return Response.json({ ok: true, generatedAt: snapshot.generatedAt });
  },
};

const COMPILED_ROUTES = compileRoutes(
  API.map((spec) => ({ ...spec, handler: HANDLERS[spec.name] })),
);

async function route(req: Request, url: URL, now: number, ip: string): Promise<Response> {
  // Alerts/push are a prefix-matched SUB-ROUTER, not table routes: they own a
  // whole namespace and may decline a request inside it, which then falls
  // through to the tail exactly as it did in the if-chain.
  if (url.pathname.startsWith("/api/push/") || url.pathname.startsWith("/api/alerts/")) {
    const res = await handleAlertRequest(req, url);
    if (res) return res;
  }
  const m = matchRoute(COMPILED_ROUTES, req.method, url.pathname);
  if (m) return m.handler({ req, url, now, ip, params: m.params });
  return serveStatic(url.pathname);
}

// ---- server ---------------------------------------------------------------

const server = Bun.serve({
  hostname: cfg.bind.host,
  port: cfg.bind.port,
  idleTimeout: 0, // SSE connections stay open
  maxRequestBodySize: MAX_BODY_BYTES, // global backstop (chunked bodies too)
  async fetch(req, srv) {
   try {
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

    // Reject an oversized DECLARED body before reading it — a fast, pre-auth
    // guard on the memory-amplification surface (`/api/enroll` and friends).
    // Only the upload route may be large; the global maxRequestBodySize backstops
    // chunked bodies with no Content-Length.
    if (exceedsBodyCap(url.pathname, req.headers.get("content-length"))) {
      return secured(
        Response.json({ error: "payload too large" }, { status: 413 }),
        origin,
        secure,
      );
    }

    // The fail-closed gate — EVERY request passes here before any handler.
    // Default deny; the guard's tiny allowlist (static shell, /api/health,
    // /api/enroll) is the only way through without a valid device token.
    const tokenValid = await verifyToken(req.headers.get("x-bifrost-token"));

    // Brute-force throttle — scoped to the auth-decision surface: only a request
    // WITHOUT a valid token can be blocked, so a shared proxy IP's failed auths
    // (the key is the socket IP = caddy on the HTTPS route) never lock out a
    // valid-token device. Verified above first, so a good token always passes.
    if (throttleBlocks(tokenValid, ip, now)) {
      return secured(
        Response.json({ error: "too many attempts" }, { status: 429 }),
        origin,
        secure,
      );
    }
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
   } catch (err) {
    // Top-level boundary: no route's uncaught throw should crash the handler
    // into a bare 500 with no log. Fail closed with a generic message (never
    // leak internals) and record what happened server-side.
    console.error("[bifrost] unhandled route error:", err);
    return new Response(JSON.stringify({ error: "internal error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
   }
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
    (lim.basis === "cgroup"
      ? `(derived from this unit's ${(lim.cgroupMaxMb! / 1024).toFixed(1)}G MemoryMax — ` +
        `the jobs run inside it; box is ${(lim.totalMb / 1024).toFixed(1)}G)`
      : `(derived from ${(lim.totalMb / 1024).toFixed(1)}G box — this unit has no MemoryMax)`),
);
