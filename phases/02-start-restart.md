# Phase 2 (Build 2) — Originate & recycle sessions

**Status: BUILT — review cycle open.** Depends on Builds 0 (auth) + 1 (drive
existing), both shipped and converged. All seven stories are implemented and the
gate is green. A red-team pass ran against this design before any code was
written and its findings are folded in below; that report is not published,
because it doubles as a directory-level inventory of the machine it was run on.

What is **not** closed is my own review cycle. The originate / resume / restart
flows and the picker rework that followed them have not had my final sign-off
pass, so this build is deliberately not declared converged. See
[phases/README.md](README.md) for how these docs are published.

## Goal

Bifrost gains the power to **originate** (start fresh) and **recycle** (resume /
restart) sessions — the last piece of the north star: *the only place I interact.*

## Constraint gate (non-negotiable)

Originate and resume are **new `claude` invocations** → the exact launch lines are
my explicit sign-off artifact. Constraint-safe form is a new *interactive* tmux
session; never `-p` / headless / SDK. The `--bg` summarize exception does not
generalize.

## IA — project-centric

Sessions are nested under projects, not one flat global list. Matches how
`claude --resume` scopes (per project dir), reuses the existing project cards, avoids
rendering the full pile. Originate and resume are actions inside a project.

---

## Part A — RECYCLE (list / search / resume / restart)

### A1. The list — a materialized, mtime-first index

The resumeable set is the transcript pile (~4.4k non-agent `.jsonl` across ~74 project
dirs; the other ~13.5k `agent-*`/subagent files are non-resumeable, already excluded by
`sessions.ts` `!startsWith("agent-")`). The list is a **derived index**, not a mirror:

- **Cheap pass (all files):** mtime + slug + cwd + **name** (read the transcript *header*
  line for `customTitle`, fallback `basename(cwd)`). Names are needed for search (A3), so
  they are indexed here, not deep-parsed later.
- **Lazy deep-parse (bounded):** rank candidates by mtime; always parse live sessions;
  then walk dead candidates newest-first, parsing only until `maxHistory` *eligible*
  interactive rows accumulate. Never a blind top-60 (sidechain/scratch/headless filters
  need parsed head fields). Bounds cold-start parse to ~60-few-hundred files regardless of
  pile size — not the ~2,600-file full parse the naive loop does.
- **Persisted across restart.** The index/name-cache survives a service restart (covers the
  warm path); mtime drives incremental refresh.
- **Duplicate-uuid safety:** when two paths map to one sessionId, deterministic tiebreak
  (prefer the slug matching `cwd.replace(/[/.]/g,"-")`, else newest mtime) + a one-line
  warning. uuid is unique-enough for cwd-scoped resume routing, NOT a safe global Map key.
- **`savedDefaultEvents`** reuses the index's `{path,mtimeMs}` instead of its own sequential
  O(total) stat walk.

### A2. Curation

Default per-project view = active (tmux-resident) + recent (historyDays). Beyond that:
- **Name-search (A3)** reaches the full uncapped set.
- **Pin** (Bifrost-owned flag) keeps a session surfaced, **bypassing both** the historyDays
  cutoff and the maxHistory slice — a pinned old session always renders.

### A3. Search — name-only, in-memory, instant

Search matches **session names**, not transcript content. Pure in-memory substring match
(case-insensitive) over the A1 name index, filtered **live on every keystroke** — zero
I/O per keystroke, no subprocess, no `rg`, no debounce-for-cost. (Deliberately drops
content search: it would buffer ~1.7 GB of base64 image output into bifrost's 300 MB
cgroup → OOM. Name-only sidesteps that entire class.) Tradeoff accepted: a session is
findable by remembered name; nameless/old ones lean on pin.

### A4. Resume — positive not-live gate, all dirs

Clicking an inactive session opens a **view-only transcript**; "resume" brings it live:

1. **Gate on a POSITIVE "definitely not live" signal** — transcript mtime quiescent AND no
   live pid referencing the uuid AND no Bifrost-owned tmux session for it. Never resume on
   the *absence* of a live signal (a booting/mid-rewrite session reads not-live falsely).
   Read fresh at click time (`~/.claude/sessions/` + `/proc` with the procStart reuse
   guard) — never the ≤3s-stale tick snapshot.
2. **Under a per-uuid in-process lock** spanning check → claim → spawn → confirm. Write the
   registry **"pending/spawning" entry BEFORE** `tmux new-session`; treat pending as
   occupied. Concurrent same-uuid requests → **409 "already starting."**
3. **Launch** (constraint-safe, see Launch lines): `claude --resume <uuid>`, cd to the
   transcript's `cwd` read back from disk (the slug is lossy — `/` and `.` both collapse to
   `-`; derive cwd from the transcript/pid file, never the slug). Verify the dir exists; if
   gone, surface "degraded — cwd missing" instead of launching.

**All directories are resumable** — no realm-confine on resume. The bearer token already
grants arbitrary execution (Build 1 drives any live session), so cwd-confine was never the
security boundary; the token is. Resuming a cleanly-exited session is Claude's own everyday
path — distinct from idle-park's risky kill-then-resume (track 3, deferred).

### A5. Restart

Recycle a live session: kill its tmux + relaunch.
- **Resume-restart (default):** kill + `claude --resume <uuid>` — same conversation.
- **Fresh-restart:** kill + new session (new uuid, blank history) in the same cwd. Does NOT
  delete the old transcript — it stays on disk, resumable later.

Killing loses in-flight turn state → **confirm-before-kill** every time. Sequence the kill
by **direct probes** (`tmux kill-session` rc, `/proc` gone), never the stale snapshot, then
relaunch under the same per-uuid lock.

---

## Part B — ORIGINATE (start fresh)

### B1. Spawn mechanics

- **Pin the uuid:** `claude --session-id <uuid>` (verified flag). Generate uuid → write
  pending registry → spawn → confirm up → mark active. Deterministic tmux→uuid mapping.
- **Spawn through the owning user's tmux server** (shared socket, same uid), never fork claude as a
  bifrost child — that keeps the pane under `user@<uid>.service/tmux-spawn-*.scope` (the
  user-slice budget), not `system.slice/bifrost.service` (300 MB, would couple a claude OOM
  to bifrost). Confirmed by spike.
- **Launch via resolved binary, not bare `claude`.** A bifrost-issued pane inherits
  bifrost.service's minimal PATH (no `~/.local/bin`) — bare `claude` is `command not found`,
  **verified**. Use the absolute path (`/home/you/.local/bin/claude`) or a `bash -lc` login
  wrapper, with a pre-spawn assertion that the resolved binary exists.
- **argv, never shell.** name / model / cwd as `execFile` args. **Model from an allowlist**
  (Opus 4.8 / Sonnet 4.6 / Haiku / Fable 5).
- **cwd guarded to under `/home/you`** (home-tree belt) — originate can name any path, so this
  blocks a garbled cwd from spawning in a system dir. (Resume needs no such guard — it only
  reaches dirs that already have transcripts.)
- **Dynamic memory gate (replaces a static cap).** Before spawn, read `user-<uid>.slice`
  headroom (the ~2.85 GB cap shared with every process in my user slice): hard floor → **block**
  ("free memory — close a session," naming the heaviest idle session bifrost already
  tracks); caution band → **warn-and-allow**. The slice cap is the hard backstop.
- **Spawn-confirm + reap, branched on `new-session` exit code:** rc≠0 ⇒ name collision /
  launch-refused — delete the pending row, surface "try again," no confirm-poll. rc==0 ⇒
  confirm-poll: assert the **specific `<uuid>.jsonl` exists AND its cwd reads back == intended
  cwd** (not dir non-emptiness — guards the slug-collision case); on timeout, reap the pane +
  delete the pending row. One teardown path from both branches.
- **Drive-confirm ≠ boot-confirm.** After spawn-confirm, poll `resolveTarget(...)` until ok
  before reporting driveable (force one out-of-band tick so the tty→pane join lands).
  "Active" is defined as "resolveTarget returns ok." ("Promptable for free" overstated it —
  there is a ~tick settling window.)

### B2. Naming

Name spawned sessions by a Bifrost-owned uuid token (`bifrost-spawn-<uuid8>` /
`<projectslug>-<uuid8>`). The `<group>-<n>` suffix on existing sessions is tmux's
server-global session-id — assigned by tmux at creation, not Bifrost's to allocate, and a
shared counter — so a guessed integer is wrong and collision-prone. Correctness rides the
uuid + exact live-tmux-set membership (`target.ts`), never the name; the tmux name carries
no weight. Optionally read back `#{session_id}` and rename after spawn for cosmetics.

---

## The registry — thin, spawn-only

Durable sidecar for **Bifrost-spawned sessions only**: `uuid → {cwd, label, spawn-reason,
state}` where state ∈ {pending, active}. Written pending **before** spawn (the boot-window
liveness signal), flipped to active on confirm, atomic JSON under gitignored `data/`.

- **Serialize mutations through an in-process single-writer queue** — the existing atomic
  store's temp path is `${path}.tmp.${process.pid}`, and bifrost is one process, so two
  concurrent originates share one tmp and lose a row. The queue makes read-modify-write
  atomic.
- **No `tmux-session` field stored** (or advisory only) — the drive path resolves the live
  name every tick; a stored name only misleads (names recycle). Registry job = uuid → cwd /
  label / spawn-reason crash-survival.

Claude-originated sessions need no sidecar (uuid = filename, cwd = transcript). "Archived"
is a Bifrost flag, not a Claude state.

## Security model

- **The token is the boundary.** Build 0's device-enrolled, revocable, throttled bearer
  gate is the real control; harden it, not ceremony around it.
- **No step-up auth** on originate/resume/restart — consistent with the above; the token
  already implies arbitrary execution via Build 1 driving.
- **No realm-confine on resume** (all dirs). **Originate cwd guarded to `/home/you`.**
- argv only; model allowlisted; the launch/inject surface stays pure + tested first.

## Launch lines — the sign-off artifacts (signed off before build)

- **Start fresh:** `tmux new-session -d -s bifrost-spawn-<uuid8> -c <cwd> \
  /home/you/.local/bin/claude --session-id <uuid> --model <m>`
- **Resume:** `tmux new-session -d -s bifrost-spawn-<uuid8> -c <cwd> \
  /home/you/.local/bin/claude --resume <uuid>`

(Absolute binary path per the PATH finding; or the `bash -lc` wrapper equivalent. argv, via
the shared user tmux server. Exact final form is the sign-off.)

## Verified facts (spikes + direct check against a live box)

- A bifrost-issued tmux pane inherits **bifrost.service's** PATH (no `~/.local/bin`) → bare
  `claude` = NOT_FOUND. **Directly verified.**
- A pane spawned via the user's tmux server lands under `user@<uid>.service/tmux-spawn-*.scope`.
  The only memory cap in the hierarchy is `user-<uid>.slice` (~2.85 GB), shared across all of
  every process in the user slice — not per-pane.
- `--session-id` / `--resume` / `--model` are real flags. Transcripts record `cwd`; slugs
  are lossy. The `<group>-<n>` suffix is tmux's global session-id.

## Resolved decisions

1. **Resume scope:** all directories (no confine). Originate cwd guarded to `/home/you`.
2. **Step-up auth:** none — the bearer token is the accepted boundary.
3. **Resource control:** dynamic memory gate (block/warn on `user-<uid>.slice` headroom), not
   a static N or per-pane MemoryMax.
4. **Restart:** resume-restart default; fresh-restart available; confirm-before-kill always.
5. **Index persistence:** persisted across restart.
6. **ssh-agent:** accepted limitation — `git push` to SSH remotes fails from spawned
   sessions; gh/HTTPS covers my repos.

## Gates

Builds 0+1 shipped ✓ · red-team folded ✓ · launch-line sign-off ✓ · greenlight ✓
→ autonomous phased build, then review.
