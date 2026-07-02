# Bifrost

A self-hosted web dashboard for running [Claude Code](https://claude.com/claude-code) on a dev box. It shows every project and live session on the machine, and lets you drive sessions from any device on your private network — phone included.

Bifrost reads session transcripts and `/proc` directly, so it sees everything: interactive sessions, background agents, subprocess trees, context-window usage, system pressure. For interactive tmux sessions it goes further than watching — you can send prompts, answer permission menus, interrupt a running turn, or open a live terminal mirror. Installed as a PWA, it sends a push notification when a session needs you; tapping it opens the exact session waiting for an answer.

## How it was built

Bifrost was implemented end-to-end in Claude Code sessions under a documented working agreement: requirements are agreed with the owner first, the build then runs autonomously, and a review cycle follows until both sides converge. Every cycle ships contract tests for the logic it added — tests encode the requirement, not the implementation. The commit history is the build log: per-milestone commits with co-author trailers. The design documents the shipped builds were greenlit against are preserved in `phases/`.

## Features

**Sessions.** Every session on the box appears as a card or table row with its activity state (`needs you` / `approval` / `paused` / `working`), derived from the transcript tail and cross-checked against `/proc`. Cards show where the session lives (tmux / ssh / desktop), which model it runs, and a context-window gauge that tracks model switches — when the window size is a guess rather than a measurement, the gauge says so. Fan-out agents and background tasks are attributed to their owning session by matching transcript tool calls against live process command lines; work that detached from its parent process is recovered through task-output file descriptors. Filters (residence, model, activity) narrow the board.

**Drive.** Open a session and the conversation renders live over SSE, with collapsible tool calls and markdown. Typing is local and instant; drafts sync across devices; sending has a short grace window during which you can cancel. Interrupt sends Esc — never Ctrl-C, which would kill the session. When Claude shows a permission menu, Bifrost parses it from the pane and renders answer buttons; if the parse isn't confident, it shows the raw pane instead of guessing, because a silently wrong answer is worse than no answer. There is also a slash-command suggester, a permission-mode toggle (auto / accept edits / plan), file attach, and a read-only xterm.js terminal mirror as the fallback for anything the structured view can't handle.

**Alerts and push.** A signal engine derives 12 tunable signals (session waiting, approval needed, memory pressure, service down, and so on) and maps them to Web Push notifications, which work away from your network. Session alerts deep-link into the drive view.

**Summaries.** One click summarizes a transcript using a background Claude session. A queue sized from the box's RAM keeps concurrent jobs bounded; results are cached until the transcript changes.

**Projects and files.** Project cards show branch, dirty state, and recent activity for each configured directory. A read-only file browser confines every request to a project root via realpath — path traversal and symlink escapes resolve outside the root and are rejected.

**Auth.** Enrollment is a QR code carrying a single-use, time-limited code, minted from a CLI on the box. Devices trade it for a 256-bit token checked in constant time. Guessing is throttled per IP. Host and origin allowlists block DNS-rebinding and CSRF, every response carries a CSP, and revoking a device takes effect immediately, including for open SSE streams.

## Design constraints

- **No headless Claude.** Bifrost never invokes `claude -p` or the Agent SDK (a hard project constraint — programmatic usage bills separately). It observes through disk and `/proc`, and interacts by injecting keystrokes into existing interactive sessions through tmux. The one exception: summaries start an interactive-class background session, and only when you click.
- **Latency lives in transport, not interaction.** Input echoes locally and is sent on commit; keystrokes never cross the network one at a time.
- **Single user, private network.** Bifrost binds a private interface (a Tailscale IP, a LAN address) and is not meant to face the internet. Auth exists so that a lost phone is not a lost box.
- **No database.** One Bun process. Everything is read live from disk and `/proc` with mtime-keyed caches.

## Architecture

```
server/                Bun + TypeScript (run natively, no build step)
  index.ts             HTTP + SSE + static serving of web/dist
  collectors/          sessions (transcripts + /proc), projects (git), system
  drive/               transcript parser, tmux send + target validation,
                       permission-menu parser, drafts, slash scan, uploads
  alerts/              signal derivation, alert engine, Web Push, VAPID keys
  auth/                request guard, tokens, enrollment, throttle + CLI
  files/               realpath-confined read-only browser
web/                   Vite + React 19 + Tailwind v4 SPA
shared/                one Snapshot type, used by both sides
deploy/bifrost.service systemd unit
```

- **Fast tick (3s):** sessions + system → snapshot → pushed to browsers over SSE.
- **Slow tick (30s):** project/git scans + transcript-index sweep.
- Session presentation is swappable: `web/src/lib/selectors.ts` shapes the data and `web/src/views/sessions/` holds the views behind a registry. A new view is one component and one registry entry.

## Tests

`bun run check` runs the unit suite (305 tests across 31 files) plus server and web typechecks. The tests cover the logic layer: transcript parsing, state derivation, process attribution, tmux target validation, menu parsing, the summarize queue, auth, window resolution, filters, and view models. Presentation is verified by eye; any logic added in a review cycle ships with tests in that cycle's commit.

## Requirements

- Linux (Bifrost reads `/proc`)
- [Bun](https://bun.sh)
- tmux, for driving sessions
- Claude Code installed and used on the same box
- A private network to serve on — a Tailscale tailnet, VPN, or LAN

## Run

```sh
cp bifrost.config.example.json bifrost.config.json
# edit: bind host (a private IP), realms (project dirs), auth allowlists

bun install
cd web && bun install && bun run build && cd ..   # build the frontend once

bun server/index.ts        # serve API + frontend
bun run enroll             # mint a QR enrollment code for your first device
```

For frontend development: `cd web && bun run dev` proxies `/api` to the running server.

The `auth.origins` / `auth.hosts` allowlists must match the exact host you browse to, or every request is denied — that is the fail-closed default. `auth.enrollUrl` is the address the QR code points new devices at; if you want push notifications and camera-based QR enrollment on iOS, that address needs HTTPS (for example via `tailscale serve` or a local Caddy in front).

Environment overrides: `BIFROST_CONFIG` (config path), `BIFROST_DATA_DIR` (token/alert storage, default `data/`), `BIFROST_VAPID_SUBJECT` (contact address in Web Push headers).

## Deploy as a service

The repo ships a systemd unit. Edit `deploy/bifrost.service` first — set `User`, `Group`, `WorkingDirectory`, and the `bun` path in `ExecStart` to match your box — then:

```sh
sudo cp deploy/bifrost.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bifrost
sudo systemctl status bifrost
```

Server code changes need a service restart. Frontend changes only need `cd web && bun run build` — the running server picks up the new bundle. Footprint in practice: ~52MB RSS, ~0% CPU when idle.

## Status

v1 is shipped and in daily use: the full observe layer, plus driving existing tmux sessions. Starting, resuming, and restarting sessions from the dashboard is under active development on a local branch and lands here once it converges through review.

## License

MIT
