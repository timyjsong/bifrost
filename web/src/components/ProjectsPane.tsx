import { useState } from "react";
import { motion } from "motion/react";
import type { ProjectInfo } from "../../../shared/types";
import { relTime } from "../lib/format";
import { Chip, Dot, Panel, SectionTitle } from "./ui";

function ProjectCard({ p, now }: { p: ProjectInfo; now: number }) {
  const active = p.liveSessions > 0;
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
    >
      <Panel
        className={`flex h-full flex-col gap-2 p-4 ${active ? "border-gold-dim/40" : ""}`}
      >
        <div className="flex items-center gap-2">
          {active && <Dot tone="gold" pulse />}
          <span className="truncate text-[14px] font-medium text-ink">
            {p.name}
          </span>
          <Chip tone="mute">{p.realm}</Chip>
          {active && (
            <span className="ml-auto text-[11px] text-gold">
              {p.liveSessions} live
            </span>
          )}
        </div>
        {p.blurb && (
          <p className="line-clamp-2 text-[12px] leading-relaxed text-ink-mute">
            {p.blurb}
          </p>
        )}
        <div className="mt-auto flex items-center gap-2 pt-1.5">
          {p.git ? (
            <>
              <span className="font-mono text-[11px] text-ink-mute">
                {p.git.branch}
              </span>
              {p.git.dirty > 0 && (
                <Chip tone="gold" mono>
                  +{p.git.dirty}
                </Chip>
              )}
              <span className="min-w-0 flex-1 truncate text-[11px] text-ink-mute/80">
                {p.git.lastCommitMsg}
              </span>
            </>
          ) : (
            <span className="text-[11px] text-ink-mute/60">no git</span>
          )}
          <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-mute tabular-nums">
            {relTime(p.lastActivityAt, now)}
          </span>
        </div>
      </Panel>
    </motion.div>
  );
}

export function ProjectsPane({
  projects,
  now,
}: {
  projects: ProjectInfo[];
  now: number;
}) {
  const realms = [...new Set(projects.map((p) => p.realm))];
  const [filter, setFilter] = useState<string | null>(null);
  const shown = filter ? projects.filter((p) => p.realm === filter) : projects;

  return (
    <section id="projects" className="scroll-mt-8">
      <SectionTitle
        title="Projects"
        hint={`${projects.length} across ${realms.length} realms`}
        right={
          realms.length > 1 ? (
            <div className="flex gap-1.5">
              {[null, ...realms].map((r) => (
                <button
                  key={r ?? "all"}
                  onClick={() => setFilter(r)}
                  className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                    filter === r
                      ? "border-gold-dim/60 text-gold"
                      : "border-line text-ink-mute hover:text-ink-dim"
                  }`}
                >
                  {r ?? "all"}
                </button>
              ))}
            </div>
          ) : undefined
        }
      />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((p) => (
          <ProjectCard key={p.path} p={p} now={now} />
        ))}
      </div>
    </section>
  );
}
