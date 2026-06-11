import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { loadConfig, repoRoot } from "./config";
import {
  collectSessions,
  type SessionSignals,
} from "./collectors/sessions";
import { collectProjects } from "./collectors/projects";
import { collectSystem } from "./collectors/system";
import { summarizeSession } from "./summarize";
import type { Snapshot, ProjectInfo, SessionInfo } from "../shared/types";

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
    cores: 0,
    mem: { totalKb: 0, availKb: 0, swapTotalKb: 0, swapFreeKb: 0 },
    procs: [],
    claudeTotalRssKb: 0,
    tmux: [],
    ports: [],
  },
};
let projects: ProjectInfo[] = [];

/** Count all descendants of a pid from a [pid, ppid] snapshot. */
function countDescendants(root: number, pidTree: [number, number][]): number {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of pidTree) {
    let arr = children.get(ppid);
    if (!arr) children.set(ppid, (arr = []));
    arr.push(pid);
  }
  let count = 0;
  const stack = [root];
  while (stack.length) {
    for (const child of children.get(stack.pop()!) ?? []) {
      count++;
      stack.push(child);
    }
  }
  return count;
}

/**
 * Derive a live interactive session's activity state from its signals.
 * Disk (transcript tail) is primary; children/CPU corroborate; the pid-file
 * status only demotes a false "awaiting" when it freshly says busy.
 */
function deriveState(
  s: SessionInfo,
  sig: SessionSignals,
  childProcs: number,
): SessionInfo["state"] {
  if (!s.live || s.headless || sig.kind === "bg") return undefined;
  const statusFresh =
    sig.pidStatusAgeMs !== undefined && sig.pidStatusAgeMs < 15_000;
  if (sig.lastEntry === "assistant_done" && sig.openTools === 0) {
    if (statusFresh && (sig.pidStatus === "busy" || sig.pidStatus === "shell")) {
      return "working";
    }
    return childProcs > 0 ? "paused" : "awaiting";
  }
  if (
    sig.openTools > 0 &&
    childProcs === 0 &&
    (sig.cpuQuietMs ?? 0) > 10_000 &&
    !(statusFresh && sig.pidStatus === "busy")
  ) {
    return "approval";
  }
  return "working";
}

let fastBusy = false;
async function fastTick() {
  if (fastBusy) return;
  fastBusy = true;
  try {
    const [sessRes, sysRes] = await Promise.all([
      collectSessions(cfg),
      collectSystem(),
    ]);
    for (const s of sessRes.sessions) {
      const sig = sessRes.signals.get(s.sessionId);
      if (!sig || !s.pid) continue;
      const childProcs = countDescendants(s.pid, sysRes.pidTree);
      s.childProcs = childProcs;
      s.state = deriveState(s, sig, childProcs);
      if (s.state !== "working") s.nowDoing = undefined; // snippet only meaningful mid-work
    }
    snapshot = {
      generatedAt: Date.now(),
      projects,
      sessions: sessRes.sessions,
      system: sysRes.info,
    };
    broadcast(snapshot);
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
