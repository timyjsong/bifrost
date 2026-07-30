/**
 * Serialization + idle-gating for the deferred picker flow (model / effort /
 * rewind). Under the "peek-and-release" design the backend picker is opened only
 * to read its options and then IMMEDIATELY closed (drive/picker.ts closePicker),
 * so it never sits open waiting on the human — abandoning the UI mid-flow strands
 * nothing. Commit re-opens, drives to the chosen row, confirms, closes.
 *
 * Two hazards this module guards, both about stray Esc:
 *  - Interleaved Escs. A release Esc and a later commit/cancel Esc landing within
 *    the TUI's Esc-Esc window would pair into the rewind-history gesture.
 *    `withPickerLock` serializes every picker op per session so two never race.
 *  - Esc into a live turn. `pickerIdle` refuses to open a picker while the pane
 *    is mid-turn, so the open→drive→release dance never runs against a thinking
 *    session (closePicker is already footer-gated and won't Esc a bare prompt,
 *    but not opening at all removes the window entirely).
 */
import { capturePane } from "./send";
import { isPaneWorking } from "./menu";
import { pickerVisible } from "./picker";

const chains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after any in-flight picker op for this session has settled, so their
 * TUI keystrokes never interleave. Per-session: different sessions run freely.
 * The tail entry is dropped once it settles (bounded memory).
 */
export function withPickerLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(sessionId) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run regardless of the prior op's outcome
  const tail = run.catch(() => {});
  chains.set(sessionId, tail);
  void tail.then(() => {
    if (chains.get(sessionId) === tail) chains.delete(sessionId);
  });
  return run;
}

/**
 * Whether it's safe to open a picker on this pane: not mid-turn and not already
 * showing a picker. A working session must never be poked (an open would inject
 * or Esc into a live turn); an already-open picker means a prior op is unresolved.
 */
export async function pickerIdle(target: string): Promise<boolean> {
  const pane = await capturePane(target);
  return !isPaneWorking(pane) && !pickerVisible(pane);
}
