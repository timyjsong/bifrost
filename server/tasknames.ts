import { readlinkSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

// taskId -> description given by the session (null = searched, not found)
const nameCache = new Map<string, string | null>();

/** Task id from an fd symlink target, if it's a tasks/<id>.output file. */
export function taskIdFromLink(target: string): string | undefined {
  return target.match(/\/tasks\/([a-z0-9]+)\.output$/)?.[1];
}

/**
 * Task id + owning session from an fd target like
 * /tmp/claude-1000/<cwd-slug>/<sessionId>/tasks/<id>.output — how a
 * background agent's stdout points back at the session that spawned it.
 */
export function taskOwnerFromLink(
  target: string,
): { taskId: string; ownerSessionId: string } | undefined {
  const m = target.match(/\/([0-9a-f-]{36})\/tasks\/([a-z0-9]+)\.output$/);
  return m ? { ownerSessionId: m[1], taskId: m[2] } : undefined;
}

/** Symlink target of a process fd, if readable. */
export function fdLink(pid: number, fd: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/fd/${fd}`);
  } catch {
    return undefined;
  }
}

/** Background-task id for a pid, via its stdout fd -> tasks/<id>.output. */
export function taskIdForPid(pid: number): string | undefined {
  try {
    return taskIdFromLink(readlinkSync(`/proc/${pid}/fd/1`));
  } catch {
    return undefined;
  }
}

/**
 * Full untruncated cmdline for a pid. The ps snapshot caps args at 160 chars,
 * which a shell-snapshot wrapper's preamble alone nearly fills — naming needs
 * the real text.
 */
export function fullArgsForPid(pid: number): string | undefined {
  try {
    const s = readFileSync(`/proc/${pid}/cmdline`)
      .toString("utf8")
      .replaceAll("\0", " ")
      .trim();
    return s || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The name a session gave its background task, recovered from the session
 * transcript: the tool_result announcing the task id is correlated back to
 * its tool_use, whose input carries the description. Cached per task id —
 * the scan runs once per task, not per tick.
 */
export async function resolveTaskName(
  taskId: string,
  transcriptPath: string | undefined,
): Promise<string | undefined> {
  const cached = nameCache.get(taskId);
  if (cached !== undefined) return cached ?? undefined;
  if (!transcriptPath) return undefined;

  let raw: string;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch {
    return undefined;
  }
  // bg shell tasks announce "with ID: <id>"; spawned agents "agentId: <id>"
  const markers = [`with ID: ${taskId}`, `agentId: ${taskId}`];
  const descByToolUse = new Map<string, string>();
  let toolUseId: string | undefined;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    if (line.includes('"tool_use"') && line.includes('"description"')) {
      try {
        const d = JSON.parse(line);
        for (const c of d.message?.content ?? []) {
          if (c?.type === "tool_use" && typeof c.input?.description === "string") {
            descByToolUse.set(c.id, c.input.description);
          }
        }
      } catch {
        // partial line
      }
    }
    const marker = markers.find((m) => line.includes(m));
    if (!toolUseId && marker) {
      try {
        const d = JSON.parse(line);
        for (const c of d.message?.content ?? []) {
          if (
            c?.type === "tool_result" &&
            JSON.stringify(c.content ?? "").includes(marker)
          ) {
            toolUseId = c.tool_use_id;
          }
        }
      } catch {
        // partial line
      }
    }
  }
  const name = toolUseId ? (descByToolUse.get(toolUseId) ?? null) : null;
  nameCache.set(taskId, name);
  return name ?? undefined;
}
