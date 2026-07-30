/**
 * Bifrost's API surface, declared as data.
 *
 * Not the WHOLE surface: `/api/push/*` and `/api/alerts/*` are a prefix-matched
 * sub-router in `alerts/manager.ts`, reached before this table and free to
 * decline a request inside its own namespace. Thirty of the thirty-eight
 * endpoints are here; those eight are not, and `surface.test.ts` therefore says
 * nothing about them.
 *
 * Deliberately free of imports from the server: this module boots nothing, so
 * the surface can be asserted in a test without standing up Bun.serve, the
 * collectors and the timers. index.ts supplies the handlers, keyed by `name` —
 * and because that map is typed `Record<RouteName, Handler>`, a route declared
 * here without a handler is a compile error rather than a 404 someone finds in
 * production.
 *
 * Order is significant: `matchRoute` takes the first match.
 */

/** Session/conversation uuids as Claude Code writes them. */
export const UUID36 = /^[0-9a-f-]{36}$/;
/** The three verbs every deferred picker (rewind / model / effort) accepts. */
export const PICKER_ACTION = /^(open|select|cancel)$/;

export interface RouteSpec {
  readonly name: string;
  readonly method?: string | readonly string[];
  readonly path: string;
  readonly where?: Readonly<Record<string, RegExp>>;
}

export const API = [
  { name: "enroll", method: "POST", path: "/api/enroll" },
  { name: "state", path: "/api/state" },
  { name: "sessionIndex", path: "/api/session-index" },
  { name: "sessionsPin", method: "POST", path: "/api/sessions/pin" },
  { name: "summarize", method: "POST", path: "/api/sessions/:id/summarize", where: { id: UUID36 } },
  { name: "files", path: "/api/files" },
  { name: "dirs", path: "/api/dirs" },
  { name: "events", path: "/api/events" },
  { name: "sessionEvents", path: "/api/session/:id/events" },
  { name: "prompt", method: "POST", path: "/api/session/:id/prompt" },
  { name: "promptCancel", method: "POST", path: "/api/session/:id/prompt/cancel" },
  { name: "interrupt", method: "POST", path: "/api/session/:id/interrupt" },
  { name: "pane", method: "GET", path: "/api/session/:id/pane" },
  { name: "mode", method: "POST", path: "/api/session/:id/mode" },
  { name: "answer", method: "POST", path: "/api/session/:id/answer" },
  { name: "capture", method: "GET", path: "/api/session/:id/capture" },
  { name: "slash", method: "GET", path: "/api/session/:id/slash" },
  { name: "diff", method: "GET", path: "/api/session/:id/diff" },
  { name: "rewind", method: "POST", path: "/api/session/:id/rewind/:action", where: { action: PICKER_ACTION } },
  { name: "model", method: "POST", path: "/api/session/:id/model/:action", where: { action: PICKER_ACTION } },
  { name: "effort", method: "POST", path: "/api/session/:id/effort/:action", where: { action: PICKER_ACTION } },
  { name: "search", method: "GET", path: "/api/search" },
  { name: "draft", method: ["GET", "PUT"], path: "/api/session/:id/draft" },
  { name: "upload", method: "POST", path: "/api/session/:id/upload" },
  { name: "lifecyclePark", method: "GET", path: "/api/lifecycle/park" },
  { name: "settings", method: ["GET", "PUT"], path: "/api/settings" },
  { name: "originate", method: "POST", path: "/api/originate" },
  { name: "resume", method: "POST", path: "/api/session/:id/resume" },
  { name: "restart", method: "POST", path: "/api/session/:id/restart" },
  { name: "health", path: "/api/health" },
] as const satisfies readonly RouteSpec[];

export type RouteName = (typeof API)[number]["name"];

/** Methods a path accepts, normalised — "ANY" when it is unconstrained. */
export function methodsFor(path: string): string[] {
  return API.filter((r) => r.path === path).flatMap((r) =>
    "method" in r && r.method ? [r.method].flat() : ["ANY"],
  );
}
