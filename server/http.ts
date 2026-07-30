/**
 * Request-body size limits. `Bun.serve`'s `maxRequestBodySize` is the global
 * backstop (bounds chunked/unknown-length bodies too), but it must stay large
 * enough for the multi-file upload route — so it can't be the tight bound for
 * the pre-auth surface (`/api/enroll`) where a memory-amplification flood would
 * bite. This adds a per-route Content-Length reject that runs BEFORE the body is
 * read: only the upload route may be large; every other route (all JSON, the
 * draft cap is 100KB) is held to a small cap.
 */

/** Global backstop for Bun.serve — generous enough for multi-file uploads
 *  (25MB/file), bounded well under Bun's large default. */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Small cap for every non-upload route (all bodies are JSON; the largest,
 *  a draft, is 100KB). Comfortably above any legitimate body, far below a DoS. */
export const JSON_BODY_CAP = 1 * 1024 * 1024;

/** True if the path is the file-upload route (the one large-body exception). */
export function isUploadPath(pathname: string): boolean {
  return /^\/api\/session\/[^/]+\/upload$/.test(pathname);
}

/** The byte cap for a route: uploads get the global max, everything else the
 *  small JSON cap. */
export function bodyCapFor(pathname: string): number {
  return isUploadPath(pathname) ? MAX_BODY_BYTES : JSON_BODY_CAP;
}

/**
 * Should this request be rejected (413) before its body is read? Only when a
 * Content-Length is DECLARED and exceeds the route's cap — a fast, cheap reject
 * for the common declared-length flood. A chunked body with no Content-Length
 * returns false here and is caught by the global `maxRequestBodySize` backstop.
 */
export function exceedsBodyCap(pathname: string, contentLength: string | null): boolean {
  if (contentLength === null) return false;
  const n = Number(contentLength);
  if (!Number.isFinite(n) || n < 0) return false; // malformed → let the parser handle it
  return n > bodyCapFor(pathname);
}
