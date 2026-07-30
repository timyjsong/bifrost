/**
 * Project-centric resumeable session list (story 2-2).
 *
 * Under each project: its active (tmux-resident) and recent (within historyDays)
 * sessions, newest-first (AC2.1). A live search box filters by name across the
 * full *uncapped* index in-memory — every keystroke, no network round-trip
 * (AC2.2). Each row has a pin toggle (AC2.3); a pinned session is rescued past
 * the cutoffs server-side. Clicking an active session routes to the live drive
 * view (AC2.5); clicking an inactive one opens a view-only transcript (AC2.4).
 *
 * Pure shaping (grouping/classification/matching) lives in lib/ and is tested;
 * this component is the thin renderer + the click/pin wiring.
 */
import { useEffect, useMemo, useState } from "react";
import type {
  ProjectInfo,
  SessionInfo,
  SessionIndexEntry,
} from "../../../shared/types";
import { basename, relTime } from "../lib/format";
import { groupSessionsByProject } from "../lib/projectSessions";
import { searchByName, sessionName } from "../lib/nameSearch";
import { searchContent, setPin, useSessionIndex, type ContentHit } from "../lib/resumeable";
import { Chip, Dot, Panel, SectionTitle } from "./ui";

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 17v5M9 10.76V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v5.76l1.5 2.24H7.5L9 10.76z" />
    </svg>
  );
}

/** One session row: name, state, last-active, a pin toggle, and a click that
 *  routes active→drive / inactive→view-only. */
function SessionRow({
  s,
  now,
  pinned,
  onOpen,
  onTogglePin,
}: {
  s: SessionInfo;
  now: number;
  pinned: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
}) {
  const name = s.customTitle ?? (basename(s.cwd) || s.cwd);
  return (
    <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2 last:border-b-0 hover:bg-panel-raised/60">
      <button
        onClick={onTogglePin}
        title={pinned ? "unpin" : "pin — keep this session surfaced"}
        aria-label={pinned ? "unpin session" : "pin session"}
        aria-pressed={pinned}
        className={`grid size-7 shrink-0 place-items-center rounded-md transition-colors ${
          pinned ? "text-gold" : "text-ink-mute/50 hover:text-ink-dim"
        }`}
      >
        <PinIcon filled={pinned} />
      </button>
      <button
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        title={s.live ? "open the live session" : "open the transcript (view-only)"}
      >
        <Dot tone={s.live ? "gold" : "mute"} pulse={s.live} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{name}</span>
        {s.live ? (
          <Chip tone="gold">live</Chip>
        ) : (
          <span className="shrink-0 text-[11px] text-ink-mute">view-only</span>
        )}
        <span className="shrink-0 font-mono text-[11px] text-ink-mute tabular-nums">
          {relTime(s.lastActivityAt, now)}
        </span>
      </button>
    </div>
  );
}

/** A flat search-result row built from an index entry (which carries only the
 *  search/click-through fields). Click + pin behave like the grouped rows. */
function IndexRow({
  e,
  now,
  pinned,
  onOpen,
  onTogglePin,
}: {
  e: SessionIndexEntry;
  now: number;
  pinned: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
}) {
  const name = sessionName(e);
  return (
    <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2 last:border-b-0 hover:bg-panel-raised/60">
      <button
        onClick={onTogglePin}
        title={pinned ? "unpin" : "pin — keep this session surfaced"}
        aria-label={pinned ? "unpin session" : "pin session"}
        aria-pressed={pinned}
        className={`grid size-7 shrink-0 place-items-center rounded-md transition-colors ${
          pinned ? "text-gold" : "text-ink-mute/50 hover:text-ink-dim"
        }`}
      >
        <PinIcon filled={pinned} />
      </button>
      <button
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        title={e.live ? "open the live session" : "open the transcript (view-only)"}
      >
        <Dot tone={e.live ? "gold" : "mute"} pulse={e.live} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{name}</span>
        {e.live ? (
          <Chip tone="gold">live</Chip>
        ) : (
          <span className="shrink-0 text-[11px] text-ink-mute">view-only</span>
        )}
        <span className="shrink-0 font-mono text-[11px] text-ink-mute tabular-nums">
          {relTime(e.mtimeMs, now)}
        </span>
      </button>
    </div>
  );
}

export function ResumeablePane({
  sessions,
  projects,
  now,
  onOpenDrive,
  onOpenTranscript,
}: {
  sessions: SessionInfo[];
  projects: ProjectInfo[];
  now: number;
  onOpenDrive: (sessionId: string) => void;
  onOpenTranscript: (sessionId: string) => void;
}) {
  const [query, setQuery] = useState("");
  // Content search (server-side grep over every transcript) — debounced so a
  // keystroke burst costs one request; name search stays instant/in-memory.
  const [contentHits, setContentHits] = useState<ContentHit[]>([]);
  // In-flight cue: the content grep is ~4.7s warm, so without this the content
  // panel just pops in silently seconds after the instant name hits.
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setContentHits([]);
      setSearching(false);
      return;
    }
    let alive = true;
    setSearching(true);
    const t = setTimeout(() => {
      void searchContent(q)
        .then((h) => {
          if (alive) setContentHits(h);
        })
        .catch(() => {
          /* network/grep error — keep any prior hits, just stop the spinner */
        })
        .finally(() => {
          if (alive) setSearching(false); // clears on success AND failure
        });
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);
  // Optimistic pin set so the toggle responds instantly; reconciled by the next
  // snapshot (collector stamps `pinned`). Seed from the rendered sessions.
  const [pins, setPins] = useState<Record<string, boolean>>({});
  // The uncapped index for search (AC2.2). Refetched only when the live-session
  // membership changes — never per keystroke. Keyed by the sorted live id list.
  const liveKey = useMemo(
    () => sessions.filter((s) => s.live).map((s) => s.sessionId).sort().join(","),
    [sessions],
  );
  const index = useSessionIndex(liveKey);

  const isPinned = (id: string, fallback?: boolean): boolean =>
    id in pins ? pins[id] : (fallback ?? false);

  const togglePin = (id: string, current: boolean) => {
    const next = !current;
    setPins((p) => ({ ...p, [id]: next }));
    void setPin(id, next).then((ok) => {
      if (!ok) setPins((p) => ({ ...p, [id]: current })); // revert on failure
    });
  };

  // Route a session id: live → drive view, dead → view-only transcript. The
  // search path only has the index entry's `live` flag; the grouped path has the
  // full session — both agree on liveness.
  const open = (id: string, live: boolean) =>
    live ? onOpenDrive(id) : onOpenTranscript(id);

  const q = query.trim();
  const groups = groupSessionsByProject(sessions, projects);

  // Search hits over the FULL uncapped index (AC2.2) — substring, prefix-ranked.
  const hits = q ? searchByName(index, q) : [];

  return (
    <section id="resume" className="scroll-mt-[72px]">
      <SectionTitle
        title="Resume"
        hint={q ? `${hits.length} match${hits.length === 1 ? "" : "es"}` : `${groups.length} projects`}
      />
      <div className="mb-4">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search every session by name…"
          className="w-full rounded-lg border border-line-soft bg-panel/50 px-3.5 py-2 text-[13px] text-ink placeholder:text-ink-mute/60 focus:border-gold-dim/60 focus:outline-none"
        />
      </div>

      {q ? (
        <div className="space-y-4">
          <Panel>
            {hits.length === 0 ? (
              <div className="px-4 py-6 text-center text-[13px] text-ink-mute">
                no session names match “{q}”
              </div>
            ) : (
              hits.map((e) => (
                <IndexRow
                  key={e.sessionId}
                  e={e}
                  now={now}
                  pinned={isPinned(e.sessionId)}
                  onOpen={() => open(e.sessionId, e.live)}
                  onTogglePin={() => togglePin(e.sessionId, isPinned(e.sessionId))}
                />
              ))
            )}
          </Panel>
          {q.length >= 3 && (
            <Panel>
              <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-ink-mute">
                in conversations
                {searching && (
                  <span className="flex items-center gap-1.5 normal-case tracking-normal text-ink-mute/70">
                    <Dot tone="gold" pulse /> searching…
                  </span>
                )}
              </div>
              {contentHits.length === 0 && (
                <div className="px-3 py-4 text-[12px] text-ink-mute">
                  {searching ? "grepping every transcript…" : "no conversation text matches"}
                </div>
              )}
              {contentHits.map((h) => {
                const inIndex = index.find((e) => e.sessionId === h.sessionId);
                return (
                  <button
                    key={h.sessionId}
                    onClick={() => open(h.sessionId, inIndex?.live ?? false)}
                    className="flex w-full min-w-0 flex-col gap-0.5 border-b border-line-soft px-3 py-2 text-left last:border-b-0 hover:bg-panel-raised/60"
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                        {inIndex ? sessionName(inIndex) : h.projectSlug.replace(/^-home-you-?/, "~/").replaceAll("-", "/")}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-ink-mute tabular-nums">
                        {relTime(h.mtimeMs, now)}
                      </span>
                    </span>
                    <span className="truncate text-[12px] text-ink-mute">{h.snippet}</span>
                  </button>
                );
              })}
            </Panel>
          )}
        </div>
      ) : groups.length === 0 ? (
        <Panel>
          <div className="px-4 py-6 text-center text-[13px] text-ink-mute">
            no sessions yet — start one in a project and it shows here
          </div>
        </Panel>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => {
            const rows = [...g.active, ...g.recent];
            return (
              <Panel key={g.project.path}>
                <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
                  {g.active.length > 0 && <Dot tone="gold" pulse />}
                  <span className="truncate text-[13px] font-medium text-ink">
                    {g.project.name}
                  </span>
                  <Chip tone="mute">{g.project.realm}</Chip>
                  <span className="ml-auto text-[11px] text-ink-mute">
                    {g.active.length > 0 && (
                      <span className="text-gold">{g.active.length} active</span>
                    )}
                    {g.active.length > 0 && g.recent.length > 0 && " · "}
                    {g.recent.length > 0 && `${g.recent.length} recent`}
                  </span>
                </div>
                {rows.map((s) => {
                  const pinned = isPinned(s.sessionId, s.pinned);
                  return (
                    <SessionRow
                      key={s.sessionId}
                      s={s}
                      now={now}
                      pinned={pinned}
                      onOpen={() => open(s.sessionId, s.live)}
                      onTogglePin={() => togglePin(s.sessionId, pinned)}
                    />
                  );
                })}
              </Panel>
            );
          })}
        </div>
      )}
    </section>
  );
}
