/**
 * The route surface as data.
 *
 * Routing used to be ~950 lines of `if (url.pathname === …)` / `pathname.match(…)`
 * inside one function, which had two costs: the surface was not readable in one
 * place, and nothing could exercise a route without standing up the whole server
 * — hence zero route tests. A table makes both tractable: matching is a pure
 * function over data, so it is testable on its own, and the list of routes is
 * something you can read top to bottom.
 *
 * Matching is deliberately conservative and preserves the if-chain's semantics:
 *
 *  - First match wins, in declaration order.
 *  - A path that matches but whose METHOD does not is NOT a match — it keeps
 *    looking, exactly as falling through the old `if` did. This does not emit
 *    405; the tail of the dispatcher decides what an unmatched request becomes.
 *  - `where` constrains a param the same way the old inline regexes did (the
 *    36-char session uuid, the open|select|cancel action), so a request that
 *    fails the constraint falls through instead of reaching a handler that would
 *    have to re-reject it.
 *  - Params are percent-decoded once, here, rather than at 20 call sites.
 */

export interface RouteDef<H> {
  /** One method, several, or omitted for "any method". */
  method?: string | readonly string[];
  /** `/api/state`, or a pattern with `:name` segments: `/api/session/:id/pane`. */
  path: string;
  /** Per-param constraints; a param that fails one makes the route not match. */
  where?: Readonly<Record<string, RegExp>>;
  handler: H;
}

export interface RouteMatch<H> {
  handler: H;
  params: Record<string, string>;
  /** The matched definition — useful for asserting WHICH route won. */
  def: RouteDef<H>;
}

interface Compiled<H> {
  def: RouteDef<H>;
  segments: string[];
  methods: string[] | null;
}

function compile<H>(def: RouteDef<H>): Compiled<H> {
  const methods =
    def.method === undefined
      ? null
      : (Array.isArray(def.method) ? def.method : [def.method as string]).map((m) =>
          m.toUpperCase(),
        );
  return { def, segments: def.path.split("/"), methods };
}

/** Prepare a table once at startup; `matchRoute` then does no per-request parsing. */
export function compileRoutes<H>(defs: readonly RouteDef<H>[]): Compiled<H>[] {
  return defs.map(compile);
}

export type CompiledRoutes<H> = ReturnType<typeof compileRoutes<H>>;

/**
 * Find the first route whose path shape, param constraints and method all match.
 * Returns null when nothing does — the caller owns what that means (static file,
 * 404, the alert sub-router, …), same as before.
 */
export function matchRoute<H>(
  routes: CompiledRoutes<H>,
  method: string,
  pathname: string,
): RouteMatch<H> | null {
  const parts = pathname.split("/");
  const upper = method.toUpperCase();

  outer: for (const r of routes) {
    if (r.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    for (let i = 0; i < r.segments.length; i++) {
      const seg = r.segments[i];
      if (seg.startsWith(":")) {
        const name = seg.slice(1);
        const raw = parts[i];
        if (raw === "") continue outer; // an empty segment is never a param
        let value: string;
        try {
          value = decodeURIComponent(raw);
        } catch {
          value = raw; // malformed escape — match on the raw form rather than 500
        }
        const constraint = r.def.where?.[name];
        if (constraint && !constraint.test(value)) continue outer;
        params[name] = value;
      } else if (seg !== parts[i]) {
        continue outer;
      }
    }
    // Path shape fits. A method mismatch keeps looking, it does not 405.
    if (r.methods && !r.methods.includes(upper)) continue;
    return { handler: r.def.handler, params, def: r.def };
  }
  return null;
}

/** Every path in the table, in order — for docs and coverage assertions. */
export function routePaths<H>(routes: CompiledRoutes<H>): string[] {
  return routes.map((r) => r.def.path);
}
