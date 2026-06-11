import { readlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";

// taskId -> description given by the session (null = searched, not found)
const nameCache = new Map<string, string | null>();

/** Background-task id for a pid, via its stdout fd -> tasks/<id>.output. */
export function taskIdForPid(pid: number): string | undefined {
  try {
    const target = readlinkSync(`/proc/${pid}/fd/1`);
    return target.match(/\/tasks\/([a-z0-9]+)\.output$/)?.[1];
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
  const marker = `with ID: ${taskId}`;
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
    if (!toolUseId && line.includes(marker)) {
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
