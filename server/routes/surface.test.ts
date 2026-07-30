/**
 * Contract tests over the REAL route surface.
 *
 * Before the table these could not be written — routing was an if-chain inside
 * the request handler, so asserting "POST /api/session/:id/prompt exists and a
 * GET of it does not" meant booting a server. `routes/api.ts` is that surface as
 * data — it imports nothing from the server, so the shape of the API is
 * assertable without standing one up.
 *
 * These deliberately assert the CONTRACT (which paths exist, which methods they
 * take, what is auth-gated, what is rate-limited) rather than mirroring the
 * table entry for entry — a test that just restates the table would pass no
 * matter what broke.
 */
import { describe, expect, test } from "bun:test";
import { API, methodsFor } from "./api";
import { PREAUTH_API } from "../auth/guard";

const find = (path: string) => API.filter((r) => r.path === path);
const methodsOf = methodsFor;

describe("the surface exists and is unique", () => {
  test("every path is declared exactly once", () => {
    const seen = new Map<string, number>();
    for (const r of API) seen.set(r.path, (seen.get(r.path) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1)).toEqual([]);
  });

  test("every path is absolute and under /api", () => {
    for (const r of API) expect(r.path.startsWith("/api/")).toBe(true);
  });

  test("param segments are named, never bare wildcards", () => {
    for (const r of API) {
      for (const seg of r.path.split("/")) {
        if (seg.includes(":")) expect(seg).toMatch(/^:[a-z]+$/);
      }
    }
  });
});

describe("methods match what each route actually is", () => {
  // A route that changes state must not be reachable by GET — a GET is what a
  // link preview, a prefetch or a crawler issues.
  const mutating = [
    "/api/enroll",
    "/api/sessions/pin",
    "/api/sessions/:id/summarize",
    "/api/session/:id/prompt",
    "/api/session/:id/prompt/cancel",
    "/api/session/:id/interrupt",
    "/api/session/:id/mode",
    "/api/session/:id/answer",
    "/api/session/:id/upload",
    "/api/session/:id/rewind/:action",
    "/api/session/:id/model/:action",
    "/api/session/:id/effort/:action",
    "/api/originate",
    "/api/session/:id/resume",
    "/api/session/:id/restart",
  ];

  test.each(mutating)("%s is POST-only", (path) => {
    expect(find(path)).toHaveLength(1);
    expect(methodsOf(path)).toEqual(["POST"]);
  });

  const readOnly = [
    "/api/session/:id/pane",
    "/api/session/:id/capture",
    "/api/session/:id/slash",
    "/api/session/:id/diff",
    "/api/search",
    "/api/lifecycle/park",
  ];

  test.each(readOnly)("%s is GET-only", (path) => {
    expect(methodsOf(path)).toEqual(["GET"]);
  });

  test("the two read-write stores take exactly GET and PUT", () => {
    expect(methodsOf("/api/settings")).toEqual(["GET", "PUT"]);
    expect(methodsOf("/api/session/:id/draft")).toEqual(["GET", "PUT"]);
  });

  // Idle-park arming is a config-file decision, deliberately not a UI toggle.
  test("the idle-park surface is read-only — arming is never an API call", () => {
    expect(methodsOf("/api/lifecycle/park")).toEqual(["GET"]);
  });
});

describe("routes that spawn processes", () => {
  // These three start a claude and share the spawn rate limit. Pinned as an
  // exact set rather than a name filter: a fourth spawning route called
  // something else would slip past `/originate|resume|restart/` unnoticed, and
  // the point of this test is to make adding one require a decision here.
  const SPAWNING = [
    "/api/originate",
    "/api/session/:id/restart",
    "/api/session/:id/resume",
  ];

  test("the spawning routes are exactly the three that carry the rate limit", () => {
    expect(API.map((r) => r.path as string).filter((p) => SPAWNING.includes(p)).sort()).toEqual(
      SPAWNING,
    );
  });

  test("the surface has not grown a route this test does not know about", () => {
    expect(API).toHaveLength(30);
  });
});

describe("pre-auth surface", () => {
  // Enrollment is the ONE /api route reachable without a token (health is
  // handled before routing). This asserts against the guard's ACTUAL allowlist,
  // imported here — an earlier version of this test described PREAUTH_API in a
  // comment without importing it, so adding an entry to that set would have
  // changed nothing and failed nothing.
  test("enroll is the only route the guard admits without a token", () => {
    expect([...PREAUTH_API]).toEqual(["/api/enroll"]);
  });

  test("that allowlist entry is a real declared route, and POST-only", () => {
    expect(find("/api/enroll")).toHaveLength(1);
    expect(methodsOf("/api/enroll")).toEqual(["POST"]);
  });

  test("every pre-auth path exists in the table — no allowlisted ghosts", () => {
    for (const p of PREAUTH_API) expect(find(p).length).toBeGreaterThan(0);
  });
});
