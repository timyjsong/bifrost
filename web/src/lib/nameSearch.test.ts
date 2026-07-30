import { describe, expect, test } from "bun:test";
import { matchRank, searchByName, sessionName } from "./nameSearch";
import type { SessionInfo } from "../../../shared/types";

const s = (over: Partial<SessionInfo>): SessionInfo => ({
  sessionId: over.sessionId ?? "id",
  live: false,
  cwd: "/home/you/projects/proj",
  lastActivityAt: 0,
  ...over,
});

describe("sessionName (AC1.6)", () => {
  test("customTitle when renamed, else basename(cwd)", () => {
    expect(sessionName(s({ customTitle: "Atlas Work", cwd: "/home/you/x" }))).toBe("Atlas Work");
    expect(sessionName(s({ cwd: "/home/you/projects/ledger-api" }))).toBe("ledger-api");
    expect(sessionName(s({ customTitle: "  ", cwd: "/home/you/projects/ledger-api" }))).toBe("ledger-api");
  });
});

describe("matchRank — prefix vs mid-string vs miss", () => {
  test("prefix=0, substring=1, miss=-1, case-insensitive", () => {
    expect(matchRank("Ledger", "mim")).toBe(0);
    expect(matchRank("demo-trader", "trade")).toBe(1);
    expect(matchRank("bifrost", "zzz")).toBe(-1);
    expect(matchRank("BIFROST", "bif")).toBe(0); // case-insensitive
  });
});

describe("searchByName (AC1.6)", () => {
  const sessions = [
    s({ sessionId: "1", cwd: "/home/you/projects/demo-trader" }), // "demo-trader"
    s({ sessionId: "2", customTitle: "Trade Desk", cwd: "/x" }), // "Trade Desk"
    s({ sessionId: "3", cwd: "/home/you/projects/ledger-api" }), // "ledger-api"
    s({ sessionId: "4", cwd: "/home/you/contraband" }), // "contraband" (mid: "trab"? no)
  ];

  test("case-insensitive substring match", () => {
    const ids = searchByName(sessions, "MIM").map((x) => x.sessionId);
    expect(ids).toEqual(["3"]);
  });

  test("prefix matches rank ahead of mid-string matches", () => {
    // query "trade": "Trade Desk" is a prefix hit; "demo-trader" is mid-string.
    const ids = searchByName(sessions, "trade").map((x) => x.sessionId);
    expect(ids).toEqual(["2", "1"]);
  });

  test("blank query returns the list unchanged (no filtering)", () => {
    expect(searchByName(sessions, "   ")).toBe(sessions);
  });

  test("no match → empty", () => {
    expect(searchByName(sessions, "nonesuch")).toEqual([]);
  });

  test("stable order within a rank tier (input order preserved)", () => {
    const pool = [
      s({ sessionId: "a", cwd: "/p/alpha-one" }),
      s({ sessionId: "b", cwd: "/p/alpha-two" }),
      s({ sessionId: "c", cwd: "/p/alpha-three" }),
    ];
    const ids = searchByName(pool, "alpha").map((x) => x.sessionId);
    expect(ids).toEqual(["a", "b", "c"]); // all prefix hits, original order kept
  });

  test("matches over the full passed list (uncapped) — no internal slice", () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      s({ sessionId: `n${i}`, cwd: `/p/match-${i}` }),
    );
    expect(searchByName(many, "match").length).toBe(500);
  });
});
