import { useEffect, useState } from "react";
import type { SessionInfo, Snapshot } from "../../../shared/types";
import { groupSessions } from "../lib/selectors";
import { applyFilters, NO_FILTERS, type SessionFilters } from "../lib/sessionFilters";
import { SectionTitle } from "./ui";
import { SessionFilterBar } from "./SessionFilterBar";
import { SESSIONS_VIEWS, DEFAULT_VIEW } from "../views/sessions";

const VIEW_KEY = "atrium.sessions.view";
const FILTER_KEY = "atrium.sessions.filters";

function loadFilters(): SessionFilters {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    return raw ? { ...NO_FILTERS, ...JSON.parse(raw) } : NO_FILTERS;
  } catch {
    return NO_FILTERS;
  }
}

/** Track the xl breakpoint so views can pack into independent columns. */
function useIsWide(): boolean {
  const [wide, setWide] = useState(
    () => window.matchMedia("(min-width: 1280px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return wide;
}

/**
 * Thin shell: shapes the data (selectors), owns the view choice, renders the
 * active view from the registry. All presentation lives in views/sessions/.
 */
export function SessionsPane({
  sessions,
  now,
  summarize,
}: {
  sessions: SessionInfo[];
  now: number;
  summarize: Snapshot["summarize"];
}) {
  const isWide = useIsWide();
  const [viewId, setViewId] = useState(
    () => localStorage.getItem(VIEW_KEY) ?? DEFAULT_VIEW,
  );
  const [filters, setFilters] = useState<SessionFilters>(loadFilters);
  const view =
    SESSIONS_VIEWS.find((v) => v.id === viewId) ?? SESSIONS_VIEWS[0];
  // Only live sessions reach the views; filter that population, then group.
  const live = sessions.filter((s) => s.live);
  const filtered = applyFilters(live, filters, now);
  const groups = groupSessions(filtered);
  const liveCount =
    groups.needsYou.length + groups.working.length + groups.liveHeadless.length;
  const interactive = live.filter((s) => !s.headless).length;
  const headless = live.length - interactive;

  const updateFilters = (f: SessionFilters) => {
    setFilters(f);
    localStorage.setItem(FILTER_KEY, JSON.stringify(f));
  };

  return (
    <section id="sessions" className="scroll-mt-[72px]">
      <SectionTitle
        title="Sessions"
        hint={`${interactive} live${headless > 0 ? ` · ${headless} headless` : ""}`}
        right={
          <div className="flex gap-1.5">
            {SESSIONS_VIEWS.map((v) => (
              <button
                key={v.id}
                onClick={() => {
                  setViewId(v.id);
                  localStorage.setItem(VIEW_KEY, v.id);
                }}
                className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                  view.id === v.id
                    ? "border-gold-dim/60 text-gold"
                    : "border-line text-ink-mute hover:text-ink-dim"
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
        }
      />
      <SessionFilterBar
        filters={filters}
        onChange={updateFilters}
        shown={liveCount}
        total={live.length}
      />
      <view.Component
        groups={groups}
        now={now}
        summarize={summarize}
        isWide={isWide}
        filtersActive={filtered.length < live.length}
      />
    </section>
  );
}
