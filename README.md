# Atrium

A local web dashboard for the `dev` box — **a single pane over everything in motion**: the projects you have, which ones have live Claude Code sessions running, what's in progress, and (later) a way to interact with those sessions from the GUI itself.

> The central space every room opens onto — every project, session, and doc surfaces into one room you walk into.

## Scope

- **Now:** read-only display — observe projects, sessions, and progress at a glance. Read-only by design; other Claude sessions run on this box concurrently, so the dashboard watches, it doesn't poke at tmux or services.
- **Spans realms:** projects today; `~/docs`, `~/skills`, etc. likely later — the lens *over* the box, which is why it lives at root rather than inside `~/projects/`.
- **Later:** interactive — drive and steer Claude Code sessions from the GUI.

## Status

Scaffold only — the build happens in a dedicated session.
