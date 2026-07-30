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
import { emptyParseState, reduceLines, type ParseState } from "./transcript";

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Detect whether the file's start CHANGED (a rewrite/replace) vs merely GREW
 * (an append). Under append-only writes the head is stable — a longer head is
 * always the old head as a prefix. Divergence (neither is a prefix of the
 * other) means the bytes before our read offset changed, so reading from that
 * offset would splice garbage onto stale state → re-baseline instead. Pure.
 */
export function headDiverged(oldHead: string, newHead: string): boolean {
  if (!oldHead || !newHead) return false;
  const n = Math.min(oldHead.length, newHead.length);
  return oldHead.slice(0, n) !== newHead.slice(0, n);
}

const HEAD_BYTES = 256;

/**
 * On a RECONNECT the client already holds `resumeFrom` messages, so the fresh
 * stream can ship only the delta rather than re-shipping the whole transcript
 * (the mobile background→foreground re-ship cliff). Safe under the JSONL
 * append-only invariant this reader already relies on for in-stream appends:
 * message [resumeFrom-1] is the client's last message (an open turn may have
 * grown), so we re-send from there. If the server has FEWER messages than the
 * client claims — a truncate/rewrite — fall back to a full "state" so the
 * client re-baselines. resumeFrom 0 (a first connect) → full state. Pure.
 */
export function resumeDecision(
  messagesLen: number,
  resumeFrom: number,
): { kind: "state" } | { kind: "append"; fromIndex: number } {
  if (resumeFrom <= 0 || messagesLen < resumeFrom) return { kind: "state" };
  return { kind: "append", fromIndex: Math.max(0, resumeFrom - 1) };
}

/**
 * Incremental transcript reader: retains parse state + a byte offset so each
 * change reads and parses ONLY appended bytes, not the whole file. Returns the
 * frame(s) to send: on first read a full "state" — or, when the client passed a
 * `resumeFrom` cursor and the file hasn't shrunk under it, an "append" delta
 * from that cursor (resumable reconnect). After that, "append" deltas carry the
 * changed tail (the last open message may grow, plus any new messages). Null
 * when nothing changed.
 */
export function makeTranscriptReader(sessionId: string, path: string, resumeFrom = 0) {
  let offset = 0;
  let partial = ""; // trailing bytes with no newline yet
  let head = ""; // fingerprint of the file's first bytes (rewrite detector)
  const state: ParseState = emptyParseState();
  let started = false;

  const rebaseline = () => {
    offset = 0;
    partial = "";
    state.messages.length = 0;
    state.openAssistantId = null;
    started = false;
  };

  return async function read(): Promise<string | null> {
    let size = 0;
    try {
      size = Bun.file(path).size;
    } catch {
      size = 0;
    }
    // Rewrite detector: if the file's start changed (not merely grew), the bytes
    // before our offset are stale → reading from offset would splice garbage.
    // JSONL is append-only so this is latent, but cheap to guard against.
    let headNow = "";
    try {
      headNow = await Bun.file(path).slice(0, HEAD_BYTES).text();
    } catch {
      headNow = "";
    }
    // File shrank/rewound (a truncate) OR its head diverged (an in-place
    // rewrite / replace) → re-baseline from empty.
    if (size < offset || headDiverged(head, headNow)) {
      rebaseline();
    }
    head = headNow;
    let chunk = "";
    try {
      chunk = await Bun.file(path).slice(offset, size).text();
    } catch {
      chunk = "";
    }
    offset = size;
    const text = partial + chunk;
    const parts = text.split("\n");
    partial = parts.pop() ?? ""; // last part may be an incomplete line
    const newLines = parts;

    const beforeLen = state.messages.length;
    const mayExtendLast = state.openAssistantId !== null && beforeLen > 0;
    reduceLines(state, newLines);

    if (!started) {
      started = true;
      const decision = resumeDecision(state.messages.length, resumeFrom);
      if (decision.kind === "append") {
        return frame("append", {
          fromIndex: decision.fromIndex,
          messages: state.messages.slice(decision.fromIndex),
        });
      }
      return frame("state", { sessionId, messages: state.messages });
    }
    const fromIndex = mayExtendLast ? beforeLen - 1 : beforeLen;
    const tail = state.messages.slice(fromIndex);
    if (tail.length === 0 && state.messages.length === beforeLen) return null; // nothing changed
    return frame("append", { fromIndex, messages: tail });
  };
}

export function sessionStream(
  sessionId: string,
  // Resolver, not a fixed path: a freshly spawned session has NO transcript
  // until its first turn (claude writes <uuid>.jsonl lazily), so the stream
  // opens with an empty state — "connected, ready" — and attaches to the file
  // once the collector discovers it.
  resolvePath: () => string | undefined,
  token: string | null,
  verify: (t: string | null) => Promise<boolean>,
  pendingPollMs = 1000,
  beatMs = 25_000,
  // Client's message count on a reconnect — the reader ships only the delta
  // from here instead of the full transcript (resumable reconnect). 0 = full.
  resumeFrom = 0,
): Response {
  let watcher: FSWatcher | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let pendingPoll: ReturnType<typeof setInterval> | null = null;
  let fallbackPoll: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const cleanup = () => {
    closed = true;
    watcher?.close();
    if (beat) clearInterval(beat);
    if (debounce) clearTimeout(debounce);
    if (pendingPoll) clearInterval(pendingPoll);
    if (fallbackPoll) clearInterval(fallbackPoll);
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
      let reader: (() => Promise<string | null>) | null = null;
      // In-flight guard: the beat backstop (below) adds a second push source
      // alongside the fs.watch handler; the reader mutates shared offset/state,
      // so overlapping reads would splice garbage. Skip if one is running — the
      // next trigger (watch event or the next beat) picks up any remaining tail.
      let pushing = false;
      const push = async () => {
        if (!reader || pushing) return;
        pushing = true;
        try {
          const f = await reader(); // full "state" on first read, "append" deltas after
          if (f) send(f);
        } finally {
          pushing = false;
        }
      };
      const attach = (path: string) => {
        reader = makeTranscriptReader(sessionId, path, resumeFrom);
        try {
          watcher = watch(path, () => {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => void push(), 120); // coalesce burst writes
          });
        } catch {
          // File vanished between resolve and watch — poll instead; the reader
          // itself tolerates a missing file (reads as empty).
          fallbackPoll = setInterval(() => void push(), pendingPollMs);
        }
      };

      const path0 = resolvePath();
      if (path0) {
        attach(path0);
        await push(); // full state on connect
      } else {
        // Transcript-less live session: tell the client it's connected and
        // empty NOW, then adopt the transcript when the first turn creates it.
        // On a RECONNECT (resumeFrom>0) whose file just didn't resolve this
        // instant, stay silent so the client keeps its existing view — the
        // reader resume-appends once the file re-attaches (an empty "state"
        // here would wrongly wipe the client's transcript).
        if (resumeFrom === 0) send(frame("state", { sessionId, messages: [] }));
        pendingPoll = setInterval(() => {
          const p = resolvePath();
          if (!p || closed) return;
          clearInterval(pendingPoll!);
          pendingPoll = null;
          attach(p);
          void push();
        }, pendingPollMs);
      }

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
        // Poll backstop: fs.watch is the fast path but silently misses events on
        // remote/NFS/overlay filesystems (the GOAL targets remote sessions),
        // under inotify-limit exhaustion, or on inode replace — leaving a
        // live-TCP stream frozen with the client none the wiser (pings keep it
        // "alive"). Re-reading on each beat delivers any missed delta within one
        // beat; the incremental reader makes an unchanged file a cheap no-op.
        await push();
        send(`: ping\n\n`);
      }, beatMs);
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
