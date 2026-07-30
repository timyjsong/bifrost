/**
 * The composer injects uploaded-file paths as leading lines before the typed
 * text (DriveView: `paths.join("\n") + (text ? "\n" + text : "")`). In the
 * transcript those render as raw absolute paths; split them back out so the
 * sent message shows filename chips + the actual message body. Presentation
 * only — the injection stays byte-for-byte correct (Claude reads by path).
 *
 * Server-side naming: uploads land at `<data>/uploads/<sessionId>/<8hex>-<name>`
 * with the filename sanitized to `[A-Za-z0-9._-]` (server/drive/uploads.ts), so
 * a path is a single whitespace-free token and the random prefix is strippable
 * for display. Pure.
 */
export interface Attachment {
  path: string; // the injected absolute path (unchanged)
  name: string; // display name — the server's random prefix stripped
}

const UPLOAD_RE = /(?:^|\/)uploads\/[^/\s]+\/([^/\s]+)$/;
const TOKEN_PREFIX = /^[0-9a-f]{8}-/; // the randomBytes(4) hex the server prepends

export function parseAttachments(text: string): { attachments: Attachment[]; body: string } {
  const lines = text.split("\n");
  const attachments: Attachment[] = [];
  let i = 0;
  // Only LEADING path-only lines are the injected prefix; the first line that
  // isn't an upload path begins the body.
  for (; i < lines.length; i++) {
    const raw = lines[i].trim();
    const m = raw && !/\s/.test(raw) ? raw.match(UPLOAD_RE) : null;
    if (!m) break;
    attachments.push({ path: raw, name: m[1].replace(TOKEN_PREFIX, "") });
  }
  return { attachments, body: lines.slice(i).join("\n") };
}
