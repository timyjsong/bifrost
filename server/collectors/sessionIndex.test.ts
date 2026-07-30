import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import {
  type IndexEntry,
  basenameOf,
  boundedParse,
  loadIndex,
  nameFor,
  rankDeadCandidates,
  resolveDuplicate,
  saveIndex,
  slugFromCwd,
} from "./sessionIndex";
import { dataDir } from "../alerts/store";
import { join } from "node:path";

const entry = (p: Partial<IndexEntry> & { sessionId: string }): IndexEntry => ({
  path: `/x/${p.sessionId}.jsonl`,
  slug: "x",
  mtimeMs: 0,
  size: 0,
  cwd: "/home/you/proj",
  name: "proj",
  ...p,
});

describe("slug + name (AC1.2)", () => {
  test("slug is lossy: / and . both map to -", () => {
    expect(slugFromCwd("/home/you/my.proj")).toBe("-home-you-my-proj");
  });
  test("name = customTitle when the session was renamed", () => {
    expect(nameFor("Atlas Work", "/home/you/atlas-web")).toBe("Atlas Work");
  });
  test("name = basename(cwd) when un-renamed", () => {
    expect(nameFor(undefined, "/home/you/projects/ledger-api")).toBe("ledger-api");
    expect(nameFor("", "/home/you/projects/ledger-api")).toBe("ledger-api");
    expect(nameFor("   ", "/home/you/projects/ledger-api")).toBe("ledger-api");
  });
  test("basenameOf handles trailing slash and root", () => {
    expect(basenameOf("/home/you/proj/")).toBe("proj");
    expect(basenameOf("/")).toBe("");
  });
});

describe("resolveDuplicate (AC1.4)", () => {
  test("prefers the slug matching cwd.replace(/[/.]/g,'-')", () => {
    const cwd = "/home/you/projects/vector-lab";
    const matching = entry({
      sessionId: "dup",
      cwd,
      slug: slugFromCwd(cwd),
      path: "/a/dup.jsonl",
      mtimeMs: 100, // older — but slug match wins over mtime
    });
    const other = entry({
      sessionId: "dup",
      cwd,
      slug: "-some-other-slug",
      path: "/b/dup.jsonl",
      mtimeMs: 999,
    });
    expect(resolveDuplicate(other, matching)).toBe(matching);
    expect(resolveDuplicate(matching, other)).toBe(matching);
  });
  test("neither slug matches → newest mtime wins (deterministic, no flicker)", () => {
    const cwd = "/home/you/projects/vector-lab";
    const older = entry({ sessionId: "dup", cwd, slug: "-stale-a", mtimeMs: 100 });
    const newer = entry({ sessionId: "dup", cwd, slug: "-stale-b", mtimeMs: 200 });
    // order-independent: same winner whichever way the args come in
    expect(resolveDuplicate(older, newer)).toBe(newer);
    expect(resolveDuplicate(newer, older)).toBe(newer);
  });
  test("tie on mtime → larger size, then path — fully deterministic", () => {
    const base = { sessionId: "dup", cwd: "/c", slug: "-x", mtimeMs: 5 };
    const small = entry({ ...base, size: 10, path: "/z/dup.jsonl" });
    const big = entry({ ...base, size: 99, path: "/a/dup.jsonl" });
    expect(resolveDuplicate(small, big)).toBe(big);
    expect(resolveDuplicate(big, small)).toBe(big);
  });
});

describe("rankDeadCandidates (AC1.1)", () => {
  test("excludes live + sub-cutoff, sorts newest-first", () => {
    const entries = [
      entry({ sessionId: "live", mtimeMs: 1000 }),
      entry({ sessionId: "old", mtimeMs: 10 }), // below cutoff
      entry({ sessionId: "b", mtimeMs: 300 }),
      entry({ sessionId: "a", mtimeMs: 500 }),
    ];
    const ranked = rankDeadCandidates(entries, new Set(["live"]), 100);
    expect(ranked.map((e) => e.sessionId)).toEqual(["a", "b"]);
  });
});

describe("boundedParse (AC1.1) — the bound", () => {
  test("with N≫cap, parse count is bounded (≈cap + slack), not O(N)", async () => {
    const cap = 60;
    const N = 2000;
    // All eligible: parse exactly `cap` then stop.
    const ranked = Array.from({ length: N }, (_, i) =>
      entry({ sessionId: `s${i}`, mtimeMs: N - i }),
    );
    let parses = 0;
    const { rows, parsed } = await boundedParse(
      ranked,
      cap,
      async (e) => {
        parses++;
        return { headless: false, id: e.sessionId };
      },
      (r) => !r.headless,
    );
    expect(parsed).toBe(cap);
    expect(parses).toBe(cap);
    expect(rows.length).toBe(cap);
    expect(parsed).toBeLessThan(N); // emphatically not O(N)
  });

  test("non-eligible (headless / skipped) parses don't count toward the cap", async () => {
    const cap = 3;
    // Pattern: skip, headless, eligible, repeated. Only the eligibles fill the cap;
    // the parse count is cap-eligibles + the skips/headless seen along the way,
    // and we STOP the instant the 3rd eligible lands.
    const kinds = [
      "skip",
      "headless",
      "eligible", // 1
      "skip",
      "eligible", // 2
      "headless",
      "eligible", // 3 -> stop here
      "eligible", // never reached
      "eligible",
    ];
    const ranked = kinds.map((k, i) => entry({ sessionId: `${k}-${i}`, mtimeMs: 1000 - i }));
    let parses = 0;
    const { rows, parsed } = await boundedParse(
      ranked,
      cap,
      async (e) => {
        parses++;
        if (e.sessionId.startsWith("skip")) return null;
        return { headless: e.sessionId.startsWith("headless") };
      },
      (r) => !r.headless,
    );
    // Parsed indices 0..6 (7 parses) to get 3 eligibles; index 7+ never touched.
    expect(parsed).toBe(7);
    expect(parses).toBe(7);
    expect(rows.filter((r) => !r.headless).length).toBe(cap);
  });
});

describe("persistence round-trip (AC1.3)", () => {
  afterEach(async () => {
    await rm(join(dataDir, "session-index.json"), { force: true });
  });

  test("save then load returns the same entries", async () => {
    const map = new Map<string, IndexEntry>([
      ["a", entry({ sessionId: "a", mtimeMs: 1, cwd: "/home/you/a", name: "a" })],
      ["b", entry({ sessionId: "b", mtimeMs: 2, cwd: "/home/you/b", name: "Renamed" })],
    ]);
    await saveIndex(map);
    const loaded = await loadIndex();
    expect(loaded.size).toBe(2);
    expect(loaded.get("b")?.name).toBe("Renamed");
    expect(loaded.get("a")?.cwd).toBe("/home/you/a");
  });

  test("missing file loads to an empty map (first boot)", async () => {
    await rm(join(dataDir, "session-index.json"), { force: true });
    const loaded = await loadIndex();
    expect(loaded.size).toBe(0);
  });
});
