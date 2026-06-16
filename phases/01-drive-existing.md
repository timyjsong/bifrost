# Phase 1 (Build 1) — Drive existing sessions, end to end

**Status:** PLANNED — scope agreed; full requirements + ACs at phase start. Depends
on Build 0 (auth) shipping first. No greenlight yet.

**Why this slice:** smallest *useful* unit — turns Bifrost into a real Claude Code
client for the already-tmuxed sessions. Touches NO new `claude` invocation (injects
into existing interactive sessions only), so it sidesteps the hard constraint and the
billing question entirely.

## Goal
For an existing tmux-resident session: view it live (incl. the think-stream), prompt
it, answer its permission prompts, and interrupt it — all from Bifrost.

## Scope (the quartet)
1. **View live** — render the conversation from the transcript (Channel 1,
   block-level live updates); raw-terminal fallback available (Channel 3 / xterm.js).
2. **Prompt** — local-echo input box, commit-to-send via `tmux send-keys` (Channel 2).
   Literal escaping (`send-keys -l`) + a separate Enter; multi-line via bracketed
   paste (`set-buffer` + `paste-buffer`) — **mechanism to spike/verify first.**
3. **Approve / deny** — detect the pending permission menu (Channel 3, minimal
   capture-pane), surface as buttons, answer via send-keys (menu selection).
4. **Interrupt** — send Esc / Ctrl-C.

## Injectable set
Promptable IFF `tmuxSession` is set (already derived in `deriveVia`,
`server/derive.ts`). Non-tmux sessions show the control disabled + the reason — never
a button that silently no-ops.

## Plumbing contract (load-bearing — Build 3+ retrofits on this)
- Normalized interaction state: messages, live-stream buffer, pending-approval,
  current mode — AND **session topology preserved** (subagents / background shells /
  fan-out, per epic principle 5) so the later flowchart view has its data.
- Command interface: `sendPrompt`, `answerApproval`, `interrupt` (+ later `setMode`,
  `startSession`, …). UI is a pure consumer.
- The send-keys / target-validation core is pure + tested (the `confine.ts` analog):
  target resolves to a known live tmux session; payload escaped; argv-not-shell.

## Open / to-decide at phase start
- State-gating: block or warn when prompting a `working` session or an attached one
  (`tmuxAttached`) — input-buffer contention with a running turn / a human typing.
- The transcript-granularity [STILL OPEN] item (block vs token) — verify here.
- Update cadence: file-watch the active session (today's 3s tick is too slow for chat).
- How much "pretty" for v1 (plain-but-functional; design is a later studio job).

## Verification (→ tests / eyeball)
- Send a prompt to a live session → it lands once, intact (incl. multi-line), submits.
- Approve/deny answers the actual menu.
- Interrupt stops a running turn.
- Target validation rejects unknown/forged session names.

## Gate
Build 0 shipped + I greenlight Build 1's locked requirements.
