/**
 * Tool-call view logic for the drive chat — the pure half of "collapse tool/
 * command calls by default, click to expand" (the claudecodeui pattern, rendered
 * in Bifrost's own styling). Kept pure so the correlation + summary contract is
 * tested; DriveView owns the rendering and the per-row expand state.
 */
import type { ContentBlock, InteractionMessage } from "../../../shared/types";

/** Declarative per-tool config (like claudecodeui's TOOL_CONFIGS): adding a tool
 *  is one row, and dogfood tweaks are one-liners. `summary` pulls the most useful
 *  one-line descriptor out of the tool's input. */
export interface ToolConfig {
  summary?: (input: Record<string, unknown>) => string | undefined;
}

const field =
  (...keys: string[]) =>
  (input: Record<string, unknown>): string | undefined => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === "string" && v) return v;
    }
    return undefined;
  };

const TOOL_CONFIGS: Record<string, ToolConfig> = {
  Bash: { summary: field("command") },
  Read: { summary: field("file_path", "path") },
  Edit: { summary: field("file_path", "path") },
  Write: { summary: field("file_path", "path") },
  NotebookEdit: { summary: field("notebook_path", "file_path") },
  Glob: { summary: field("pattern") },
  Grep: { summary: field("pattern") },
  WebFetch: { summary: field("url") },
  WebSearch: { summary: field("query") },
  Task: { summary: field("description") },
};

/** One-line summary of a tool call for the collapsed row. Config-driven per tool,
 *  with a generic-field then compact-JSON fallback for unknown tools/shapes.
 *  Not clipped — the row clips for display; expanded shows it in full. */
export function summarizeTool(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const cfg = TOOL_CONFIGS[name];
    const s = cfg?.summary?.(o);
    if (s) return s;
    const generic = field(
      "command",
      "file_path",
      "path",
      "pattern",
      "url",
      "query",
      "description",
    )(o);
    if (generic) return generic;
    try {
      const j = JSON.stringify(o);
      return j === "{}" ? "" : j;
    } catch {
      return "";
    }
  }
  return typeof input === "string" ? input : "";
}

export interface ToolResultView {
  text: string;
  isError: boolean;
}

export interface ToolIndex {
  /** The result for a given tool_use id (its tool_result lives in a later msg). */
  resultByUseId: Map<string, ToolResultView>;
  /** forIds correlated to a rendered tool_use — their standalone tool_result
   *  block is hidden (shown inside the tool-call unit instead). */
  consumedForIds: Set<string>;
}

/** Pair each tool_use with its tool_result (which arrives in a later message),
 *  so a tool call renders as ONE collapsible command+output unit. */
export function buildToolIndex(messages: InteractionMessage[]): ToolIndex {
  const useIds = new Set<string>();
  for (const m of messages) {
    for (const b of m.blocks) if (b.kind === "tool_use") useIds.add(b.id);
  }
  const resultByUseId = new Map<string, ToolResultView>();
  const consumedForIds = new Set<string>();
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.kind === "tool_result" && useIds.has(b.forId)) {
        resultByUseId.set(b.forId, { text: b.text, isError: b.isError });
        consumedForIds.add(b.forId);
      }
    }
  }
  return { resultByUseId, consumedForIds };
}

/** The blocks a message should render: a tool_result folded into its tool_use
 *  unit is dropped here so it isn't also shown standalone. An orphan tool_result
 *  (no matching tool_use) is kept. */
export function visibleBlocks(
  blocks: ContentBlock[],
  consumedForIds: Set<string>,
): ContentBlock[] {
  return blocks.filter(
    (b) => !(b.kind === "tool_result" && consumedForIds.has(b.forId)),
  );
}
