/**
 * The `/api/files` route: confine the requested path to a known project root,
 * then list it. Read-only — there is no write path here by construction.
 */
import { confinePath } from "./confine";
import { listDir } from "./browse";
import type { DirListing } from "../../shared/types";

/** Handle GET /api/files?path=<dir>&all=0|1. Returns null for any other route. */
export async function handleFilesRequest(
  url: URL,
  roots: string[],
): Promise<Response | null> {
  if (url.pathname !== "/api/files") return null;

  const requested = url.searchParams.get("path");
  if (!requested) {
    return Response.json({ error: "path required" }, { status: 400 });
  }
  const all = url.searchParams.get("all") === "1";

  const confined = await confinePath(requested, roots);
  if (!confined.ok) {
    const status = confined.reason === "not-found" ? 404 : 403;
    return Response.json({ error: confined.reason }, { status });
  }

  try {
    const entries = await listDir(confined.path, all);
    const body: DirListing = { path: confined.path, entries };
    return Response.json(body);
  } catch {
    // confined.path resolved but isn't a listable directory (a file, or EACCES)
    return Response.json({ error: "not-a-directory" }, { status: 400 });
  }
}
