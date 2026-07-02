# Bifrost

A self-hosted control tower for [Claude Code](https://claude.com/claude-code) on a dev box — one pane over every project and live session, driveable from any device on your tailnet.

Bifrost watches the whole machine — every Claude Code session (interactive or background), every project, system pressure — and lets you **drive** the interactive ones from a phone: send prompts, answer permission menus, interrupt a turn, or drop into a raw terminal mirror. Installed as a PWA, it pushes a notification when a session needs you; tapping it deep-links into the exact session waiting for an answer.

## How it was built

Bifrost is agent-built: implemented end-to-end in Claude Code sessions under a documented working agreement — requirements converged with the owner, builds run autonomously, then a review cycle iterates until convergence. Every convergence ships contract tests for that cycle's logic (tests encode the requirement, never the implementation). The commit history is the build log: per-milestone commits, honest co-author trailers.

## Features

**Sessions — the live board.** Every session on the box as a card (or table row): activity state (`needs you` / `approval` / `paused` / `working`) derived disk-first from the transcript tail and corroborated against `/proc`; residence (tmux / ssh / desktop) and model chips; a switch-aware context-window gauge resolved per session (from `/model` events, launch flags, then heuristics — a guess renders as `~`, never as measured). Subprocess attribution names fan-out agents and background tasks from transcript tool calls matched against live cmdlines — including orphans reparented to init, recovered via task-output fd links. WHERE / MODEL / ACTIVE filters compose over it all.

**Drive — interact from anywhere.** Open a session and the transcript renders live (SSE, collapsible tool calls, markdown). Type with local echo and cross-device draft sync; send is commit-to-send with a cancelable grace window. Interrupt maps to Esc (never Ctrl-C). Permission prompts are parsed from the pane and answered with a tap — with a loud fallback to the raw view when parsing isn't sure, because the one forbidden outcome is a silent wrong answer. Plus: slash-command suggester, permission-mode pill (auto / edits / plan), file attach, and an xterm.js raw-terminal mirror as the always-works escape hatch.

**Alerts + push.** A pure signal engine (edge / gauge / rate / transition kinds, hysteresis, per-instance latching) maps 12 tunable signals to Web Push notifications that deliver off-tailnet. Session-scoped alerts deep-link straight into the drive view.

**Summaries.** One click condenses a transcript via a background Claude session, behind an adaptive queue sized from box RAM; results cache by source mtime.

**Projects + files.** Realm-scoped project cards (branch, dirty state, activity) and a read-only file browser where every path is realpath-confined to a live project root — traversal and symlink escapes resolve outside and are rejected.

**Auth.** Fail-closed device enrollment: QR code with a single-use TTL enrollment code trades for a 256-bit constant-time device token; per-IP throttle; host/origin allowlists (anti DNS-rebinding / CSRF); CSP on every response; revocation is honored live, including mid-SSE-stream.

## Design constraints

- **No headless Claude.** Bifrost never invokes `claude -p` or the Agent SDK (a hard project constraint — programmatic usage bills separately). It observes via disk and `/proc`, and interacts by injecting into *interactive* sessions through tmux. The one sanctioned exception: summaries dispatch an interactive-class background session, click-initiated only.
- **Latency in transport, not interaction.** Input is local-echo and commit-to-send; keystrokes never cross the wire one at a time.
- **Single-user, tailnet-only.** The deployment posture is a private network; auth exists so a lost phone isn't a lost box.
- **No database.** One Bun process; everything is read live from disk and `/proc` with mtime-keyed caches.

## Architecture

```
server/                Bun + TypeScript (run natively, no build step)
  index.ts             HTTP + SSE + static serving of web/dist
  collectors/          sessions (transcripts + /proc), projects (git), system
  drive/               transcript parser, tmux send/target validation, pane menu
                       parser, drafts, slash scan, uploads
  alerts/              signal derivation, pure alert engine, Web Push, VAPID
  auth/                guard, tokens, enrollment, throttle + enroll CLI
  files/               realpath-confined read-only browser
web/                   Vite + React 19 + Tailwind v4 + Motion SPA (editorial dark)
shared/                one Snapshot type, used by both sides
deploy/bifrost.service systemd unit
```

- **Fast tick (3s):** sessions + system → snapshot → pushed to browsers over SSE.
- **Slow tick (30s):** project/git scans + transcript-index sweep.
- Session presentation is swappable: `web/src/lib/selectors.ts` shapes the data, `web/src/views/sessions/` holds the views behind a registry — a new view is one component and one registry line.

## Tests

`bun run check` runs the unit suite (305 tests across 31 files) plus server and web typechecks. The suite covers the logic layer — transcript parsing, state derivation, process trees, target validation, menu parsing, the summarize queue, auth (guard / tokens / enrollment / throttle), window resolution, filters, and the card view-model. Pure presentation is verified by eyeball; any logic a cycle adds ships with tests in that convergence commit.

## Run

Requires [Bun](https://bun.sh), Linux (`/proc`), tmux, and Claude Code on the box.

```sh
cp bifrost.config.example.json bifrost.config.json   # then edit: bind host, realms, auth allowlists
cd web && bun install && bun run build && cd ..      # build the frontend once
bun install
bun server/index.ts                                  # serve everything
bun run enroll                                       # mint a QR enrollment code for a device
```

Dev loop for the frontend: `cd web && bun run dev` (proxies `/api` to the running server).

Deploy 24/7 with the included systemd unit (`deploy/bifrost.service`). Footprint: ~52MB RSS, ~0% CPU idle.

## Status

v1 is shipped and in daily use: the full observe layer plus drive-existing-sessions. Session lifecycle (originate / resume / restart from the dashboard) is under active development on a local branch and lands here once it converges through review.

## License

MIT
