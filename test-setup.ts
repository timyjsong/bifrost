// Test isolation — runs as a `bun test` preload, BEFORE any test module is
// imported. The data store resolves its path from BIFROST_DATA_DIR at IMPORT
// time and freezes it (store.ts `dataDir`, tokens.ts `PATH`, etc. are
// module-level consts). A per-test `beforeAll` that sets the env runs too late
// once another test file has already imported the store — so without this, the
// auth tests' mintToken/revokeAll write to the REAL data/ dir and wipe enrolled
// devices. Pointing the whole test process at a throwaway temp dir here is the
// only place guaranteed to run before those frozen reads.
import { afterAll } from "bun:test";
import { tempDir, sweepTempDirs } from "./server/testing/tmp";

if (!process.env.BIFROST_DATA_DIR) {
  process.env.BIFROST_DATA_DIR = tempDir("bifrost-test");
}

// Global teardown for every temp dir handed out by testing/tmp.ts. It lives
// here rather than in the helper because `process.on("exit")` does not fire
// under the test runner — the suite had left hundreds of directories in /tmp.
afterAll(async () => {
  // Two passes with a drain between. A store write started inside a test but not
  // awaited by it (the session index persists itself) lands after the first
  // sweep and recreates the data dir; the second pass is what actually gets it.
  sweepTempDirs();
  await new Promise((r) => setTimeout(r, 100));
  sweepTempDirs();
});
