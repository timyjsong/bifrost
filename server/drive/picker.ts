/**
 * Shared teardown for the TUI's full-screen pickers (rewind, model, effort).
 *
 * A BLIND Esc is hazardous: when no picker is open, it can pair with a
 * neighboring Esc inside the TUI's Esc-Esc window and OPEN the rewind picker —
 * observed live when a failed open's cleanup Esc and a follow-up cancel were
 * processed back-to-back by a busy Ink. Teardown therefore keys on the
 * pickers' own footers and sends Esc only while one is actually visible.
 */
import { capturePane, sendKey } from "./send";

const PICKER_FOOTERS = [
  /Enter to continue/, // rewind checkpoints
  /s to use this session only/, // model picker
  /←\/→ to adjust/, // effort slider
];

export function pickerVisible(paneText: string): boolean {
  return PICKER_FOOTERS.some((f) => f.test(paneText));
}

/** Close any open picker: Esc only while one is visible, re-checking between
 *  presses (bounded). Returns true when the pane is picker-free on exit. */
export async function closePicker(target: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    if (!pickerVisible(await capturePane(target))) return true;
    await sendKey(target, "Escape");
    await Bun.sleep(400); // let Ink process before re-reading
  }
  return !pickerVisible(await capturePane(target));
}
