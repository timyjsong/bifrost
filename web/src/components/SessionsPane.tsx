import { useEffect, useState } from "react";
import type { SessionInfo, Snapshot } from "../../../shared/types";
import { groupSessions } from "../lib/selectors";
import { SectionTitle } from "./ui";
import { SESSIONS_VIEWS, DEFAULT_VIEW } from "../views/sessions";

const VIEW_KEY = "atrium.sessions.view";

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
  const view =
    SESSIONS_VIEWS.find((v) => v.id === viewId) ?? SESSIONS_VIEWS[0];
  const groups = groupSessions(sessions);
  const liveCount =
    groups.needsYou.length + groups.working.length + groups.liveHeadless.length;

  return (
    <section id="sessions" className="scroll-mt-8">
      <SectionTitle
        title="Sessions"
        hint={`${liveCount} live`}
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
      <view.Component
        groups={groups}
        now={now}
        summarize={summarize}
        isWide={isWide}
      />
    </section>
  );
}
