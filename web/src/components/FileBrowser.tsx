import { useEffect, useState } from "react";
import type { FileEntry, ProjectInfo } from "../../../shared/types";
import { fetchDir } from "../lib/files";
import { fmtBytes, relTime } from "../lib/format";
import { Chip, Panel } from "./ui";
import { OriginateDialog } from "./OriginateDialog";

const REASON: Record<string, string> = {
  "outside-root": "Outside the project — blocked",
  "not-found": "Not found",
  "not-a-directory": "Not a folder",
};

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-gold-dim" fill="none">
      <path
        d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 6v6A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V4.5Z"
        fill="currentColor"
        fillOpacity="0.18"
        stroke="currentColor"
        strokeWidth="1.1"
      />
    </svg>
  );
}

function FileIcon({ link = false }: { link?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-ink-mute" fill="none">
      <path
        d="M4 1.5h5L13 5.5V14a.5.5 0 0 1-.5.5h-8A.5.5 0 0 1 4 14V1.5Z"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <path d="M9 1.5V5.5H13" stroke="currentColor" strokeWidth="1.1" />
      {link && (
        <path d="M6 11.5l4-3-4-3" stroke="currentColor" strokeWidth="1.1" />
      )}
    </svg>
  );
}

function Row({
  e,
  now,
  onOpen,
}: {
  e: FileEntry;
  now: number;
  onOpen?: () => void;
}) {
  const isDir = e.type === "dir";
  const inner = (
    <>
      {isDir ? <FolderIcon /> : <FileIcon link={e.type === "symlink"} />}
      <span
        className={`min-w-0 flex-1 truncate text-[13px] ${isDir ? "text-ink" : "text-ink-dim"}`}
      >
        {e.name}
      </span>
      {e.type === "symlink" && <Chip tone="mute">link</Chip>}
      {!isDir && (
        <span className="shrink-0 font-mono text-[11px] text-ink-mute tabular-nums">
          {fmtBytes(e.size)}
        </span>
      )}
      <span className="w-10 shrink-0 text-right font-mono text-[11px] text-ink-mute/80 tabular-nums">
        {relTime(e.mtimeMs, now)}
      </span>
      {isDir && (
        <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-ink-mute" fill="none">
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      )}
    </>
  );
  const cls =
    "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left";
  return isDir ? (
    <button
      onClick={onOpen}
      className={`${cls} w-full transition-colors hover:bg-panel-raised/70`}
    >
      {inner}
    </button>
  ) : (
    <div className={`${cls} opacity-90`}>{inner}</div>
  );
}

export function FileBrowser({
  project,
  now,
  onClose,
  onOpenDrive,
}: {
  project: ProjectInfo;
  now: number;
  onClose: () => void;
  // Start a fresh session in the browsed folder (story 2-5). When the new session
  // surfaces in the snapshot it routes into the drive view.
  onOpenDrive?: (sessionId: string) => void;
}) {
  const root = project.path;
  const [path, setPath] = useState(root);
  const [showHidden, setShowHidden] = useState(false);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [originating, setOriginating] = useState(false);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(null);
    fetchDir(path, showHidden)
      .then((listing) => {
        if (stale) return;
        setEntries(listing.entries);
      })
      .catch((err: Error) => {
        if (stale) return;
        setEntries(null);
        setError(REASON[err.message] ?? err.message);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [path, showHidden]);

  // Breadcrumb: project name as the root crumb, then each segment below it.
  const rel = path.slice(root.length).split("/").filter(Boolean);
  const crumbs = [
    { label: project.name, path: root },
    ...rel.map((seg, i) => ({
      label: seg,
      path: `${root}/${rel.slice(0, i + 1).join("/")}`,
    })),
  ];

  return (
    <Panel className="relative flex h-full flex-col p-3">
      {originating && (
        <OriginateDialog
          cwd={path}
          projectName={project.name}
          onClose={() => setOriginating(false)}
          onStarted={(sessionId) => {
            setOriginating(false);
            onOpenDrive?.(sessionId);
          }}
        />
      )}
      <div className="mb-2 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 text-[12px]">
          {/* root crumb: back out to the project grid */}
          <button
            onClick={onClose}
            className="rounded px-1 py-0.5 text-ink-mute hover:text-gold"
          >
            projects
          </button>
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center gap-0.5">
              <span className="text-ink-mute/50">/</span>
              <button
                onClick={() => setPath(c.path)}
                disabled={i === crumbs.length - 1}
                className={`max-w-[12rem] truncate rounded px-1 py-0.5 ${
                  i === crumbs.length - 1
                    ? "text-ink"
                    : "text-ink-mute hover:text-gold"
                }`}
              >
                {c.label}
              </button>
            </span>
          ))}
        </div>
        <button
          onClick={() => setOriginating(true)}
          className="shrink-0 rounded-md border border-gold-dim/60 px-2 py-0.5 text-[11px] text-gold transition-colors hover:bg-gold-dim/10"
          title="Start a Claude session in this folder"
        >
          start session
        </button>
        <button
          onClick={() => setShowHidden((v) => !v)}
          className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
            showHidden
              ? "border-gold-dim/60 text-gold"
              : "border-line text-ink-mute hover:text-ink-dim"
          }`}
          title="Show .git and node_modules"
        >
          hidden
        </button>
        <button
          onClick={onClose}
          className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-mute transition-colors hover:text-ink-dim"
        >
          close
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && entries === null ? (
          <p className="px-2.5 py-2 text-[12px] text-ink-mute">loading…</p>
        ) : error ? (
          <p className="px-2.5 py-2 text-[12px] text-danger">{error}</p>
        ) : entries && entries.length === 0 ? (
          <p className="px-2.5 py-2 text-[12px] text-ink-mute">empty folder</p>
        ) : (
          <div className="flex flex-col">
            {entries?.map((e) => (
              <Row
                key={e.name}
                e={e}
                now={now}
                onOpen={
                  e.type === "dir"
                    ? () => setPath(`${path}/${e.name}`)
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
