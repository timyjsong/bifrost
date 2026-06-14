import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { loadConfig, repoRoot } from "./config";
import { collectSessions } from "./collectors/sessions";
import {
  descendantsOf,
  leafChildren,
  cleanCommand,
  deriveState,
  deriveVia,
  nameFromCallIndex,
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
import { handleAlertRequest, evaluateAlerts } from "./alerts/manager";
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
    const descByPid = new Map<number, Set<number>>();
    for (const s of sessRes.sessions) {
      if (s.live && s.pid) {
        descByPid.set(s.pid, descendantsOf(s.pid, sysRes.pidTree));
      }
    }
    const ppidOf = new Map(sysRes.pidTree);
    for (const s of sessRes.sessions) {
      const sig = sessRes.signals.get(s.sessionId);
      if (!sig || !s.pid) continue;
      // A live claude whose pid sits inside another live session's process
      // tree is spawned automation (claude-in-claude), whatever its
      // entrypoint claims — fold it in with the headless runs.
      for (const [pid, desc] of descByPid) {
        if (pid !== s.pid && desc.has(s.pid)) {
          s.headless = true;
          break;
        }
      }
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
      s.state = s.headless
        ? undefined
        : deriveState(s, sig, descendants.size);
      if (s.state !== "working") s.nowDoing = undefined; // snippet only meaningful mid-work
    }
    // A live headless claude whose stdout feeds another live session's task
    // output is that session's background agent — show it as a child on the
    // owner's card, not as a session row of its own.
    const procByPid = new Map(sysRes.allProcs.map((p) => [p.pid, p]));
    const byId = new Map(sessRes.sessions.map((s) => [s.sessionId, s]));
    const absorbed = new Set<string>();
    for (const s of sessRes.sessions) {
      if (!s.live || !s.headless || !s.pid) continue;
      const link = fdLink(s.pid, 1);
      const owner = link ? taskOwnerFromLink(link) : undefined;
      const parent = owner ? byId.get(owner.ownerSessionId) : undefined;
      if (!owner || !parent?.live || parent.sessionId === s.sessionId) continue;
      absorbed.add(s.sessionId);
      // already visible as a ps-tree child of the owner — don't double-list
      if (parent.pid && descByPid.get(parent.pid)?.has(s.pid)) continue;
      const proc = procByPid.get(s.pid);
      parent.children = [
        ...(parent.children ?? []),
        {
          pid: s.pid,
          etime: proc?.etime ?? "",
          rssKb: proc?.rssKb ?? 0,
          cpu: proc?.cpu ?? 0,
          command: cleanCommand(fullArgsForPid(s.pid) ?? "claude (agent)"),
          // the agent's own first prompt is the best fallback name
          name:
            (await resolveTaskName(
              owner.taskId,
              transcriptPathFor(parent.sessionId),
            )) ?? s.title,
        },
      ];
      parent.childProcs = (parent.childProcs ?? 0) + 1;
    }
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
    broadcast(snapshot);
    // Derive alert signals from the same poll and push on policy-passing edges.
    // After broadcast so a source hiccup never delays the dashboard; robust on
    // its own, but caught here too — alerting must never disrupt the tick.
    await evaluateAlerts(sysRes.info, sessions, snapshot.generatedAt).catch((err) =>
      console.error("[atrium] alert eval failed:", err),
    );
  } catch (err) {
    console.error("[atrium] fast tick failed:", err);
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
    console.error("[atrium] slow tick failed:", err);
  } finally {
    slowBusy = false;
  }
}

// ---- SSE ------------------------------------------------------------------

type SSEClient = { write: (chunk: string) => void; close: () => void };
const clients = new Set<SSEClient>();

function broadcast(snap: Snapshot) {
  if (clients.size === 0) return;
  const frame = `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`;
  for (const c of clients) {
    try {
      c.write(frame);
    } catch {
      clients.delete(c);
    }
  }
}

function sseResponse(): Response {
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
      };
      clients.add(client);
      client.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    },
    cancel() {
      clients.delete(client);
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

// SSE heartbeat so proxies/browsers don't reap idle connections.
setInterval(() => {
  for (const c of clients) {
    try {
      c.write(`: ping\n\n`);
    } catch {
      clients.delete(c);
    }
  }
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
      "<!doctype html><title>Atrium</title><body style=\"background:#0a0a0a;color:#e5e5e5;font-family:sans-serif\"><p>Atrium API is up. Frontend not built yet — run <code>bun run build</code> in web/.</p>",
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

// ---- server ---------------------------------------------------------------

const server = Bun.serve({
  hostname: cfg.bind.host,
  port: cfg.bind.port,
  idleTimeout: 0, // SSE connections stay open
  async fetch(req) {
    const url = new URL(req.url);
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
    if (url.pathname === "/api/events") {
      return sseResponse();
    }
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, generatedAt: snapshot.generatedAt });
    }
    return serveStatic(url.pathname);
  },
});

await fastTick(); // sessions first, so the project scan can attribute them
await slowTick();
await fastTick();
setInterval(fastTick, cfg.refresh.fastMs);
setInterval(slowTick, cfg.refresh.slowMs);

console.log(`[atrium] watching from http://${server.hostname}:${server.port}`);
const lim = summarizeLimits(cfg);
console.log(
  `[atrium] summarize: ${lim.maxInFlight} concurrent slots, ${lim.reserveMb}MB reserve floor ` +
    `(derived from ${(lim.totalMb / 1024).toFixed(1)}G box)`,
);
