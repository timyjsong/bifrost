# Phase 1 (Build 1) — Drive existing sessions, end to end

**Status: BUILT & CONVERGED** — greenlit 2026-06-17, shipped as Build 1 (all 8
milestones), review cycle closed. This doc is the spec the build was greenlit
against, kept unedited below; the ACs were the contract.

**Why this slice:** smallest *useful* unit — turns Bifrost into a real Claude Code
client for the already-tmuxed sessions. Touches NO new `claude` invocation (injects
into existing interactive sessions only), so it sidesteps the hard constraint and the
billing question entirely. Reality check (2026-06-17): I start every non-ephemeral
session by sshing in → tmux → claude, then drives it via the GUI's remote-control. So
his real work IS tmux-resident → Build 1 covers it, not a toy subset. The only manual
step Build 1 leaves standing is *origination* — which is exactly Build 2.

## Goal
For an existing tmux-resident session: view it live (incl. the think-stream), prompt
it, answer its permission prompts, and interrupt it — all from Bifrost, from any of
my devices.

## Converged decisions (2026-06-17)
- **State-gating = warn-and-allow**, never block. `working` → warn + allow.
  `tmuxAttached` → warn (name the likely client) + allow. Non-tmux → control disabled
  + reason shown. (GUI uses remote-control, not a tmux client attach, so `tmuxAttached`
  is a true edge case in practice.)
- **Draft syncs cross-device.** The uncommitted input buffer is stored server-side
  **per session** (not per device), so desktop→phone resumes mid-typing.
  Last-write-wins on concurrent edit; no conflict UI (single-user-acceptable).
- **Approve/deny bar = works against current TUI format + loud fallback.** Version-proof
  isn't achievable; a parse failure fails LOUD with an actionable manual path, never a
  silent/wrong auto-answer.
- **xterm.js raw fallback is IN Build 1** (minimal) — the anti-lag insurance and the
  escape hatch when the semantic layer can't handle something.
- **Slash commands ride free** through the prompt box (typed text). A **minimal
  suggester** is in Build 1: scan disk (user/project custom commands + skills) + a
  static built-in list, client-side fuzzy filter, **fill-don't-auto-send**, never a
  gate. **Dedicated command buttons (model-switch, `/clear`, etc.) are deferred to the
  studio / Build 3** — they're a design surface, not hand-rolled here.
- **Out of Build 1:** mode-cycling (shift-tab), model-switch, start/restart (Build 2,
  needs launch-line sign-off).
- **One build, eight internal commit milestones** (commit at each boundary).

## Injectable set
Promptable IFF `tmuxSession` is set (derived in `deriveVia`, `server/derive.ts:283`).
Resolver refuses everything else. Non-tmux sessions show the control disabled + the
reason — never a button that silently no-ops.

## Plumbing contract (load-bearing — Build 3+ retrofits on this)
- Normalized interaction state: messages, live-stream buffer, pending-approval,
  current mode, **+ current draft (new)** — AND **session topology preserved**
  (subagents / background shells / fan-out, per epic principle 5) so the later
  background-tasks view has its data.
- Command interface: `sendPrompt`, `answerApproval`, `interrupt`, `saveDraft`
  (+ later `setMode`, `startSession`, …). UI is a pure consumer.
- The send-keys / target-validation core is pure + tested (the `confine.ts` analog):
  target resolves to a known live tmux session; payload escaped; argv-not-shell.

## Build order + acceptance criteria

### M1 — send-keys + target-validation core (pure, tested, NO UI) — the spine
- **AC1.1** A pure resolver maps a requested target to a known *live* tmux session;
  unknown / dead / forged names are rejected with no send attempted. Tested against
  forged/unknown/dead inputs.
- **AC1.2** Payload delivered via argv array (literal), never a shell string — pane
  metacharacters reach the session literally, not shell-interpreted. Tested.
- **AC1.3** Multi-line payload delivers intact as one unit with a separate explicit
  submit — never partial line-by-line submit. Mechanism (bracketed-paste vs
  `send-keys -l`) spiked + verified on a **throwaway** tmux session before wiring.
- **AC1.4** Target re-validated **at send time**, not only at render — a session that
  died after render yields a clean rejection, not a misdirected send.
- **AC1.5** Only `tmuxSession`-bearing sessions are injectable; single-sourced off
  existing `deriveVia`.

### M2 — live single-session view (transcript render + think-stream + reconnect)
- **AC2.1** Renders the conversation from the transcript JSONL —
  assistant/user/tool_use/tool_result — in order.
- **AC2.2** An assistant turn renders its content blocks in order: thinking
  (think-stream) → text → tool_use (one-line-per-block structure).
- **AC2.3** Live updates land at **block granularity** sub-second via a file-watch on
  the active session's transcript (not the 3s poll). Token-by-token streaming *within*
  a block is resolved by a spike and is NOT required for acceptance.
- **AC2.4** On SSE drop + reconnect (phone backgrounded), the view rebuilds from the
  transcript with no missing and no duplicated blocks.
- **AC2.5** Normalized state preserves session topology (subagent / background-shell /
  fan-out tree), even though Build 1 renders linearly — verified the tree is carried,
  ready for Build 3.

### M3 — prompt (local-echo + draft-sync + commit-to-send)
- **AC3.1** Typing is local-echo, instant, zero network per keystroke (keystrokes
  never cross the wire individually).
- **AC3.2** On commit, the prompt delivers via M1 to the target, lands **once**,
  intact (incl. multi-line), and submits.
- **AC3.3** Draft (uncommitted input) persists server-side **per session**, debounced;
  opening the same session on another device loads it. Last-write-wins on concurrent
  edit, no conflict UI.
- **AC3.4** Optimistic local echo reconciles against the transcript's real
  user-message line — the message shows once, not duplicated.
- **AC3.5** `working` → warn + allow; `tmuxAttached` → warn (name likely client) +
  allow; non-tmux → disabled + reason. Nothing blocks.
- **AC3.6** A failed send (dead session / validation reject) surfaces LOUD ("session
  ended"), never a silent drop; the draft is preserved so input isn't lost.

### M4 — interrupt (contextual stop button)
- **AC4.1** The interrupt affordance is a **stop button that renders ONLY while the
  session is processing a turn** (working state) — absent otherwise. There is NO
  always-present interrupt control to mis-click.
- **AC4.2** It requires a deliberate mouse click; clicking it cancels/stops the
  running turn (verified live).
- **AC4.3** Under the hood it sends the verified interrupt keystroke (Esc) to the
  pane — the user never sees a raw "Esc" control. Ctrl-C is never wired (risks
  exiting the session). Exact key verified against the live TUI during the build,
  not from memory.

### M5 — approve/deny (capture-pane parser + loud fallback)
- **AC5.1** A minimal `capture-pane` read detects a pending permission menu and
  surfaces Approve/Deny (+ numbered options) as buttons.
- **AC5.2** Answering routes the correct menu key via M1 and the actual menu advances.
- **AC5.3** On parse failure (TUI format drift), the UI fails LOUD — shows the raw
  menu text + an actionable manual path (send the selection via the prompt box / raw
  terminal). Never a silent or wrong auto-answer.
- **AC5.4** Parser tested against the current Claude Code menu format (captured fixture).

### M6 — xterm.js raw fallback
- **AC6.1** A raw-terminal (xterm.js) live mirror of the session's pane, one tap from
  the session view.
- **AC6.2** At least one actionable manual path always exists when the semantic layer
  can't handle something — interactive raw input if included, else the prompt box +
  raw capture text. Latency tolerated here (this is the fallback, not the no-lag path).

### M7 — slash suggester
- **AC7.1** Typing `/` shows suggestions from scanned disk (user/project custom
  commands + skills) + a static built-in list; client-side fuzzy filter, zero network.
- **AC7.2** Picking a suggestion **fills** the input (no auto-send) so args can be
  added; commit-to-send unchanged.
- **AC7.3** Suggestions never gate — any slash command can be typed raw and sent.
- **AC7.4** Disk scan cached, refreshed on a slow cadence (not per-keystroke).

### M8 — push → answer-from-phone deep-link (the capstone)
- **AC8.1** The `session_approval` push payload carries a deep-link to the session.
- **AC8.2** A `notificationclick` in the SW opens/focuses the PWA to that session's
  drive view.
- **AC8.3** End to end: push → tap → approve, verified on the iOS PWA.

## Cross-cutting (spine — applies to every milestone)
- All write endpoints (prompt / answer / interrupt / draft) sit behind the Build 0
  auth gate (already enforced on both routes).
- The send-keys / target-validation core is pure + unit-tested **before** its UI.
- The real send path gets an integration test against a **throwaway** tmux session,
  never my live work.
- **No payload content filtering** — security lives at the auth + target-validation
  layer; "anything typeable" is the design.
- Commit at each milestone boundary; keep BUILD-STATE.md current; `bun run check`
  green at every commit.

## Gate
Build 0 shipped (✓ — its final hardening folds into Build 1's first deploy) +
**my explicit greenlight on these locked ACs.** Alignment ≠ greenlight.
