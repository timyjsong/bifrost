import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { taskIdFromLink, taskOwnerFromLink, resolveTaskName } from "./tasknames";
import { tempDir } from "./testing/tmp";

describe("taskIdFromLink", () => {
  test("extracts the task id from a task output path", () => {
    expect(
      taskIdFromLink("/tmp/claude-1000/-home-you-bifrost/sid/tasks/b6typnoft.output"),
    ).toBe("b6typnoft");
  });
  test("non-task fds yield nothing", () => {
    expect(taskIdFromLink("/dev/pts/0")).toBeUndefined();
    expect(taskIdFromLink("socket:[12345]")).toBeUndefined();
  });
});

describe("taskOwnerFromLink", () => {
  test("extracts owner session + task id from a task output path", () => {
    expect(
      taskOwnerFromLink(
        "/tmp/claude-1000/-home-you-work-atlas-web/cccc7777-1111-2222-3333-888899990000/tasks/b3lha2zd0.output",
      ),
    ).toEqual({
      ownerSessionId: "cccc7777-1111-2222-3333-888899990000",
      taskId: "b3lha2zd0",
    });
  });
  test("task paths without a session uuid segment yield nothing", () => {
    expect(
      taskOwnerFromLink("/tmp/claude-1000/-slug/tasks/b6typnoft.output"),
    ).toBeUndefined();
    expect(taskOwnerFromLink("pipe:[2380300]")).toBeUndefined();
  });
});

describe("resolveTaskName", () => {
  test("recovers the description via tool_use_id correlation, then caches", async () => {
    const path = join(tempDir("bifrost-tn-"), "t.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_123",
                name: "Bash",
                input: {
                  command: "sleep 600",
                  description: "Dummy eval process",
                  run_in_background: true,
                },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_123",
                content: "Command running in background with ID: zztest123",
              },
            ],
          },
        }),
      ].join("\n"),
    );
    expect(await resolveTaskName("zztest123", path)).toBe("Dummy eval process");
    // cached: works even if the transcript is now unreadable
    expect(await resolveTaskName("zztest123", "/nonexistent")).toBe(
      "Dummy eval process",
    );
  });
  test("unknown id resolves to undefined", async () => {
    const path = join(tempDir("bifrost-tn2-"), "t.jsonl");
    writeFileSync(path, "");
    expect(await resolveTaskName("nope99", path)).toBeUndefined();
  });
});
