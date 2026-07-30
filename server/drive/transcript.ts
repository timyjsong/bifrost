/**
 * Transcript-body parser — Channel 1 (output). Reduces a session's raw transcript
 * JSONL to a normalized InteractionState: ordered messages, each an ordered list
 * of content blocks. Pure (lines in → state out), so the render contract is
 * unit-tested against fixtures and the live endpoint (./live.ts) stays a thin
 * I/O shell.
 *
 * The transcript writes one JSONL line per assistant content block, all sharing
 * `message.id` (verified against this repo's own transcript: thinking → text →
 * tool_use land as consecutive lines). We regroup those lines back into one
 * assistant turn. User entries are either a string prompt or an array of
 * tool_results. `isMeta` user lines (injected reminders / command noise) are not
 * conversation and are dropped. `isSidechain` rides through untouched so the
 * subagent tree survives (AC2.5).
 */
import type {
  ContentBlock,
  InteractionMessage,
  InteractionState,
} from "../../shared/types";

interface RawEntry {
  type?: string;
  uuid?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  timestamp?: string;
  message?: { id?: string; role?: string; content?: unknown };
}

/** A tool_result's content is a string or an array of {type:"text",text}. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && (c as { type?: string }).type === "text"
          ? String((c as { text?: string }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

/** Map a raw message.content (string or block array) to normalized blocks. */
function toBlocks(content: unknown): ContentBlock[] {
  if (typeof content === "string") {
    return content.trim() ? [{ kind: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const raw = b as Record<string, unknown>;
    switch (raw.type) {
      case "thinking":
        out.push({ kind: "thinking", text: String(raw.thinking ?? "") });
        break;
      case "text":
        out.push({ kind: "text", text: String(raw.text ?? "") });
        break;
      case "tool_use":
        out.push({
          kind: "tool_use",
          id: String(raw.id ?? ""),
          name: String(raw.name ?? ""),
          input: raw.input,
        });
        break;
      case "tool_result":
        out.push({
          kind: "tool_result",
          forId: String(raw.tool_use_id ?? ""),
          text: resultText(raw.content),
          isError: !!raw.is_error,
        });
        break;
    }
  }
  return out;
}

/**
 * Incremental parse state — retained across appends so the live stream can feed
 * only NEW lines instead of re-parsing the whole file each tick (perf: a
 * multi-MB transcript under steady output). `openAssistantId` is the message.id
 * of the turn still open to more block-lines.
 */
export interface ParseState {
  messages: InteractionMessage[];
  openAssistantId: string | null;
}

export function emptyParseState(): ParseState {
  return { messages: [], openAssistantId: null };
}

/**
 * Reduce more transcript lines into an existing parse state, in place. Because
 * the transcript is append-only and a turn's block-lines are contiguous, feeding
 * new lines onto retained state is identical to a full re-parse — the last
 * message may grow (same message.id) or new messages append.
 */
export function reduceLines(state: ParseState, lines: string[]): void {
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: RawEntry;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = e.timestamp ? Date.parse(e.timestamp) || 0 : 0;

    if (e.type === "assistant" && e.message) {
      const blocks = toBlocks(e.message.content);
      if (!blocks.length) continue;
      const id = e.message.id ?? null;
      const last = state.messages[state.messages.length - 1];
      if (id && id === state.openAssistantId && last && last.role === "assistant") {
        last.blocks.push(...blocks); // another block-line of the same turn
      } else {
        state.messages.push({
          uuid: e.uuid ?? "",
          role: "assistant",
          isSidechain: !!e.isSidechain,
          blocks,
          ts,
        });
        state.openAssistantId = id;
      }
    } else if (e.type === "user" && e.message) {
      state.openAssistantId = null; // a user line ends any open assistant turn
      if (e.isMeta) continue; // injected reminders / local-command output — not conversation
      const blocks = toBlocks(e.message.content);
      if (!blocks.length) continue;
      state.messages.push({
        uuid: e.uuid ?? "",
        role: "user",
        isSidechain: !!e.isSidechain,
        blocks,
        ts,
      });
    }
    // every other entry type (system / mode / custom-title / attachment /
    // last-prompt / queue-operation / file-history-snapshot) is not conversation
    // content for Build 1; leave any open assistant turn intact.
  }
}

/**
 * Parse raw transcript lines (file order = chronological) into the normalized
 * state. Consecutive assistant lines sharing `message.id` collapse into one turn.
 */
export function parseTranscript(
  lines: string[],
  sessionId: string,
): InteractionState {
  const state = emptyParseState();
  reduceLines(state, lines);
  return { sessionId, messages: state.messages };
}
