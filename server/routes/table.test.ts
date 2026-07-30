import { describe, expect, test } from "bun:test";
import { compileRoutes, matchRoute, routePaths, type RouteDef } from "./table";

const UUID = /^[0-9a-f-]{36}$/;
const PICKER = /^(open|select|cancel)$/;

// A miniature of the real table, exercising each shape it has to support.
const defs: RouteDef<string>[] = [
  { path: "/api/state", handler: "state" },
  { method: "POST", path: "/api/sessions/pin", handler: "pin" },
  {
    method: "POST",
    path: "/api/sessions/:id/summarize",
    where: { id: UUID },
    handler: "summarize",
  },
  { method: "GET", path: "/api/session/:id/pane", handler: "pane" },
  { method: ["GET", "PUT"], path: "/api/session/:id/draft", handler: "draft" },
  {
    method: "POST",
    path: "/api/session/:id/model/:action",
    where: { action: PICKER },
    handler: "model",
  },
  { path: "/api/session/:id/events", handler: "events" },
];
const routes = compileRoutes(defs);
const match = (m: string, p: string) => matchRoute(routes, m, p);

describe("matching", () => {
  test("an exact path with no method constraint takes any method", () => {
    expect(match("GET", "/api/state")?.handler).toBe("state");
    expect(match("POST", "/api/state")?.handler).toBe("state");
  });

  test("params are captured by name", () => {
    const m = match("GET", "/api/session/abc123/pane");
    expect(m?.handler).toBe("pane");
    expect(m?.params).toEqual({ id: "abc123" });
  });

  test("a route can accept several methods", () => {
    expect(match("GET", "/api/session/x/draft")?.handler).toBe("draft");
    expect(match("PUT", "/api/session/x/draft")?.handler).toBe("draft");
    expect(match("DELETE", "/api/session/x/draft")).toBeNull();
  });

  test("the method comparison is case-insensitive", () => {
    expect(match("post", "/api/sessions/pin")?.handler).toBe("pin");
  });

  test("two params on one path both come through", () => {
    const m = match("POST", "/api/session/sid-1/model/select");
    expect(m?.params).toEqual({ id: "sid-1", action: "select" });
  });
});

describe("non-matches fall through rather than erroring", () => {
  // The old if-chain fell through on a method mismatch and the request ended up
  // at the tail (static / 404). Emitting 405 here would be a behaviour change.
  test("a path that matches with the wrong method is simply not a match", () => {
    expect(match("GET", "/api/sessions/pin")).toBeNull();
  });

  test("an unknown path is not a match", () => {
    expect(match("GET", "/api/nope")).toBeNull();
  });

  test("a longer or shorter path never matches a pattern of another length", () => {
    expect(match("GET", "/api/session/x/pane/extra")).toBeNull();
    expect(match("GET", "/api/session/pane")).toBeNull();
  });

  test("an empty param segment does not match", () => {
    expect(match("GET", "/api/session//pane")).toBeNull();
  });

  test("a param failing its constraint falls through, it does not reach a handler", () => {
    expect(match("POST", "/api/sessions/not-a-uuid/summarize")).toBeNull();
    expect(
      match("POST", "/api/sessions/1a2b3c4d-1111-2222-3333-444455556666/summarize")?.handler,
    ).toBe("summarize");
  });

  test("an action outside the allowed set falls through", () => {
    expect(match("POST", "/api/session/sid/model/delete")).toBeNull();
    expect(match("POST", "/api/session/sid/model/open")?.handler).toBe("model");
  });
});

describe("param decoding", () => {
  test("params are percent-decoded once, at the match", () => {
    expect(match("GET", "/api/session/a%20b/pane")?.params.id).toBe("a b");
    expect(match("GET", "/api/session/a%2Fb/pane")?.params.id).toBe("a/b");
  });

  // A stray % is a client mistake, not a reason to 500 the request.
  test("a malformed escape falls back to the raw segment instead of throwing", () => {
    expect(() => match("GET", "/api/session/100%/pane")).not.toThrow();
    expect(match("GET", "/api/session/100%/pane")?.params.id).toBe("100%");
  });
});

describe("ordering", () => {
  test("first declaration wins", () => {
    const t = compileRoutes<string>([
      { path: "/api/a/:x", handler: "first" },
      { path: "/api/a/:y", handler: "second" },
    ]);
    expect(matchRoute(t, "GET", "/api/a/1")?.handler).toBe("first");
  });

  test("a literal declared before a param still wins for its own path", () => {
    const t = compileRoutes<string>([
      { path: "/api/a/fixed", handler: "literal" },
      { path: "/api/a/:x", handler: "param" },
    ]);
    expect(matchRoute(t, "GET", "/api/a/fixed")?.handler).toBe("literal");
    expect(matchRoute(t, "GET", "/api/a/other")?.handler).toBe("param");
  });
});

test("routePaths lists the surface in declaration order", () => {
  expect(routePaths(routes)[0]).toBe("/api/state");
  expect(routePaths(routes)).toHaveLength(defs.length);
});
