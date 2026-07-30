/**
 * Temp directories for tests, swept when the test process exits.
 *
 * Roughly a dozen test files were calling `mkdtemp` directly with no cleanup —
 * the suite had left 843 stale directories in /tmp. Per-site cleanup is what got
 * forgotten in the first place, so this registers the sweep centrally instead:
 * ask for a directory here and it goes away, whether the test passed, failed or
 * threw. Tests that genuinely need a directory to outlive the run can still call
 * mkdtemp themselves.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created: string[] = [];

/**
 * Remove everything handed out so far. Called from a global `afterAll` in
 * test-setup.ts — NOT from `process.on("exit")`, which the test runner does not
 * fire. Failures are ignored: a temp dir we could not remove must never turn a
 * green run red.
 *
 * The list is NOT consumed, so this is idempotent and can be called again after
 * a drain. That matters for the shared data dir: a store write started inside a
 * test but not awaited by it lands after the sweep and recreates the directory,
 * so one pass is not always the last word.
 */
export function sweepTempDirs(): void {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** A fresh temp directory under /tmp, removed when this test process exits. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix.endsWith("-") ? prefix : `${prefix}-`));
  created.push(dir);
  return dir;
}

/** A path inside a fresh temp directory — for tests that just need one file. */
export function tempFile(prefix: string, name: string): string {
  return join(tempDir(prefix), name);
}
