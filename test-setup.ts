// Test isolation — runs as a `bun test` preload, BEFORE any test module is
// imported. The data store resolves its path from BIFROST_DATA_DIR at IMPORT
// time and freezes it (store.ts `dataDir`, tokens.ts `PATH`, etc. are
// module-level consts). A per-test `beforeAll` that sets the env runs too late
// once another test file has already imported the store — so without this, the
// auth tests' mintToken/revokeAll write to the REAL data/ dir and wipe enrolled
// devices. Pointing the whole test process at a throwaway temp dir here is the
// only place guaranteed to run before those frozen reads.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.BIFROST_DATA_DIR) {
  process.env.BIFROST_DATA_DIR = mkdtempSync(join(tmpdir(), "bifrost-test-"));
}
