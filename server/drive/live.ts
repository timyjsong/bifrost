/**
 * Per-session live stream — the I/O shell over the pure parser (./transcript.ts).
 * Emits the full InteractionState on connect, then again (debounced) whenever the
 * transcript file changes. fs.watch gives sub-second latency; because every push
 * is the FULL current state, a reconnect (a fresh stream) is consistent by
 * construction — no missing or duplicated blocks (AC2.4).
 *
 * The connecting token is re-verified on each heartbeat and the stream is cut if
 * it's been revoked, mirroring the global sweep's revocation bound (./sse.ts)
 * without entangling the global broadcast registry — this stream carries only its
 * own session's frames.
 */
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseTranscript } from "./transcript";

async function readState(path: string, sessionId: string) {
  const raw = await readFile(path, "utf8").catch(() => "");
  return parseTranscript(raw.split("\n"), sessionId);
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function sessionStream(
  sessionId: string,
  path: string,
  token: string | null,
  verify: (t: string | null) => Promise<boolean>,
): Response {
  let watcher: FSWatcher | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const cleanup = () => {
    closed = true;
    watcher?.close();
    if (beat) clearInterval(beat);
    if (debounce) clearTimeout(debounce);
  };

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          /* stream already torn down */
        }
      };
      const push = async () => send(frame("state", await readState(path, sessionId)));

      await push(); // full state on connect

      watcher = watch(path, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void push(), 120); // coalesce burst writes
      });

      beat = setInterval(async () => {
        if (!(await verify(token))) {
          cleanup();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          return;
        }
        send(`: ping\n\n`);
      }, 25_000);
    },
    cancel() {
      cleanup();
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
