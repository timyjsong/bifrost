/**
 * Shared transcript rendering — the parse-to-blocks render path used by both the
 * live drive view (DriveView) and the view-only open (TranscriptView, story 2-2
 * AC2.4). One source of truth for how a session's conversation looks: user
 * bubbles, assistant text/thinking, and collapsible tool calls. Parsing happens
 * server-side (drive/transcript.ts, streamed as InteractionState); this module
 * is pure presentation over the parsed messages.
 */
import { useState } from "react";
import { clip } from "../lib/format";
import { parseCommandTurn } from "../lib/commandView";
import { parseAttachments } from "../lib/attachments";
import { PaperclipIcon } from "./ui";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ContentBlock,
  InteractionMessage,
} from "../../../shared/types";
import {
  summarizeTool,
  visibleBlocks,
  type ToolIndex,
  type ToolResultView,
} from "../lib/toolView";

/** One tool/command call, collapsed to a single row by default; click to expand
 *  its full input + output. Errors turn the row red so a failure reads at a
 *  glance without expanding. */
export function ToolCall({
  name,
  input,
  result,
}: {
  name: string;
  input: unknown;
  result?: ToolResultView;
}) {
  const summary = summarizeTool(name, input);
  const [expanded, setExpanded] = useState(false);
  const err = result?.isError ?? false;
  return (
    <div className="font-mono text-[12px]">
      <button
        onClick={() => setExpanded((v) => !v)}
        className={`flex w-full items-baseline gap-1.5 text-left transition-colors ${
          err ? "text-danger/90 hover:text-danger" : "text-ink-mute hover:text-ink-dim"
        }`}
      >
        <span className={`shrink-0 ${err ? "text-danger/70" : "text-ink-mute/60"}`}>
          {expanded ? "▾" : "▸"}
        </span>
        <span className={`shrink-0 ${err ? "text-danger" : "text-auto"}`}>→ {name}</span>
        <span className={`min-w-0 truncate ${err ? "text-danger/80" : "text-ink-mute/80"}`}>
          {clip(summary, 160)}
        </span>
        {result && (
          <span className={`ml-auto shrink-0 ${err ? "text-danger" : "text-ink-mute/40"}`}>
            {err ? "✗" : "✓"}
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-1 space-y-1.5 border-l border-line-soft pl-3">
          {summary && (
            <div className="whitespace-pre-wrap break-words text-[11.5px] leading-snug text-ink-mute/80">
              {summary}
            </div>
          )}
          {result && (
            <div
              className={`whitespace-pre-wrap break-words text-[11.5px] leading-snug ${
                result.isError ? "text-danger/90" : "text-ink-mute/70"
              }`}
            >
              {clip(result.text.trim(), 2000) || "(no output)"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Block({ b }: { b: Exclude<ContentBlock, { kind: "tool_use" }> }) {
  switch (b.kind) {
    case "thinking":
      return (
        <div className="whitespace-pre-wrap border-l-2 border-line-soft pl-3 text-[12.5px] italic leading-relaxed text-ink-mute/80">
          {b.text}
        </div>
      );
    case "text":
      return (
        <div className="chat-md text-[13.5px] leading-relaxed text-ink-dim">
          <Markdown remarkPlugins={[remarkGfm]}>{b.text}</Markdown>
        </div>
      );
    case "tool_result":
      return (
        <div
          className={`whitespace-pre-wrap break-words border-l border-line-soft pl-3 font-mono text-[11.5px] leading-snug ${
            b.isError ? "text-danger/90" : "text-ink-mute/70"
          }`}
        >
          {clip(b.text.trim(), 600) || "(no output)"}
        </div>
      );
  }
}

function renderBlock(tools: ToolIndex) {
  return (b: ContentBlock, i: number) =>
    b.kind === "tool_use" ? (
      <ToolCall key={i} name={b.name} input={b.input} result={tools.resultByUseId.get(b.id)} />
    ) : (
      <Block key={i} b={b} />
    );
}

export function Message({ m, tools }: { m: InteractionMessage; tools: ToolIndex }) {
  const isUser = m.role === "user";
  const isToolResult = isUser && m.blocks.every((b) => b.kind === "tool_result");
  // A tool_result folded into its tool-call unit isn't rendered standalone; if
  // that empties the message (all blocks were consumed results), drop it.
  const blocks = visibleBlocks(m.blocks, tools.consumedForIds);
  if (blocks.length === 0) return null;
  const render = renderBlock(tools);

  if (isUser && !isToolResult) {
    // Slash-command turns (typed /model, /clear, …) arrive as XML-ish markup —
    // render a compact command chip / muted output line, never the raw tags.
    const joined = m.blocks
      .filter((b) => b.kind === "text")
      .map((b) => (b.kind === "text" ? b.text : ""))
      .join("\n");
    const cmd = parseCommandTurn(joined);
    if (cmd?.kind === "command") {
      return (
        <div className="flex justify-end">
          <span className="rounded-full border border-line-soft bg-panel-raised/40 px-3 py-1 font-mono text-[12px] text-ink-dim">
            {cmd.name}
            {cmd.args ? <span className="text-ink-mute"> {cmd.args}</span> : null}
          </span>
        </div>
      );
    }
    if (cmd?.kind === "output") {
      if (!cmd.text) return null;
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap break-words border-r-2 border-line-soft pr-3 text-right font-mono text-[11.5px] leading-snug text-ink-mute">
            {cmd.text}
          </div>
        </div>
      );
    }
    // The composer injects uploaded-file paths as leading lines; render them as
    // filename chips instead of raw paths, with the typed body below.
    const { attachments, body } = parseAttachments(joined);
    if (attachments.length > 0) {
      return (
        <div className="flex justify-end">
          <div className="flex max-w-[85%] flex-col items-end gap-1.5">
            <div className="flex flex-wrap justify-end gap-1.5">
              {attachments.map((a) => (
                <span
                  key={a.path}
                  className="inline-flex max-w-[200px] items-center gap-1 rounded-md border border-line-soft bg-bg/60 px-2 py-1 text-[11px] text-ink-dim"
                >
                  <span className="shrink-0 text-ink-mute/70">
                    <PaperclipIcon />
                  </span>
                  <span className="truncate">{a.name}</span>
                </span>
              ))}
            </div>
            {body.trim() && (
              <div className="chat-md rounded-lg rounded-br-sm border border-gold-dim/40 bg-gold/[0.06] px-3.5 py-2 text-[13.5px] leading-relaxed text-ink">
                <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
              </div>
            )}
          </div>
        </div>
      );
    }
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-br-sm border border-gold-dim/40 bg-gold/[0.06] px-3.5 py-2 text-[13.5px] leading-relaxed text-ink">
          {blocks.map(render)}
        </div>
      </div>
    );
  }

  return (
    <div className={m.isSidechain ? "ml-4 border-l border-auto/30 pl-3" : ""}>
      {m.isSidechain && (
        <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-auto/70">
          subagent
        </div>
      )}
      <div className="space-y-1.5">{blocks.map(render)}</div>
    </div>
  );
}
