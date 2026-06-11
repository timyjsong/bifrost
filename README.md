# Atrium

A local web dashboard for the `dev` box — **a single pane over everything in motion**: the projects you have, which ones have live Claude Code sessions running, what's in progress, and (later) a way to interact with those sessions from the GUI itself.

> The central space every room opens onto — every project, session, and doc surfaces into one room you walk into.

**Live at `http://100.100.100.100:4444`** (tailnet only).

## Scope

- **Now (v1):** read-only display — observe projects, sessions, and progress at a glance. Read-only by design; other Claude sessions run on this box concurrently, so the dashboard watches, it doesn't poke at tmux or services.
- **Spans realms:** `~/projects` + `~/work` today; more realms (`~/docs`, `~/skills`, …) are one config line each — the lens *over* the box, which is why it lives at root rather than inside `~/projects/`.
- **Later:** interactive — drive and steer Claude Code sessions from the GUI.

## Hard constraint (v2 and forever)

**Atrium must never invoke `claude -p`, headless mode, or the Agent SDK.** From 2026-06-15, programmatic Claude Code usage bills to a separate credit bucket. v1 is structurally immune (it only reads files and `/proc`). v2 interaction must inject into *existing interactive* sessions (tmux send-keys, file/socket message bus) — never spawn a programmatic session.

## Architecture

One Bun process, no database. Everything is read live from disk and `/proc`, with mtime-keyed caches.

```
server/               Bun + TypeScript (run natively, no build step)
  index.ts            HTTP + SSE + static serving of web/dist
  collectors/
    sessions.ts       ~/.claude/sessions/<pid>.json (+ /proc liveness, pid-reuse guard)
                      ~/.claude/projects/*/<id>.jsonl (head: title/cwd; tail: context tokens, model)
    projects.ts       realm dirs: git branch/dirty/last-commit, README blurb, activity
    system.ts         /proc/{loadavg,meminfo,uptime}, ps, tmux, ss
web/                  Vite + React 19 + Tailwind v4 + Motion SPA (editorial dark)
shared/types.ts       one Snapshot type, used by both sides
deploy/atrium.service systemd unit
```

- **Fast tick (3s):** sessions + system → snapshot → pushed to browsers over SSE (`/api/events`).
- **Slow tick (30s):** project/git scans.
- **Sessions are box-wide;** the Projects pane shows only allowlisted realms.
- Headless (sdk-driven) sessions are detected via `entrypoint` and shown collapsed.

## Run

```sh
cd web && bun install && bun run build   # build the frontend once
bun server/index.ts                      # serve everything on :4444
```

Dev loop for the frontend: `cd web && bun run dev` (proxies `/api` to the running server).

## Deploy (24/7)

```sh
sudo cp deploy/atrium.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now atrium
```

Footprint: ~52MB RSS, ~0% CPU idle.

## Config — `atrium.config.json`

| key | meaning |
| --- | --- |
| `bind` | host/port to serve on (tailnet IP by default) |
| `realms` | allowlisted project roots shown in the Projects pane |
| `refresh` | fast/slow tick intervals (ms) |
| `sessions` | history window (days) and max rows |
