/**
 * The shared shape of the three UI-select routes (rewind / model / effort).
 *
 * All three drive a full-screen TUI picker through the same dance — ensure the
 * viewport is roomy, trigger the picker, poll until it parses, and on the commit
 * pass walk the cursor to the chosen row with closed-loop arrows before
 * confirming. That was written out three times in server/index.ts, ~90 lines
 * each, with only the trigger, the parser, the arrow keys and the confirm step
 * actually differing. This module owns the parts that were identical.
 *
 * IO is injectable throughout, including the viewport check and the poll that
 * `openPicker` uses. The pane reads and keystrokes are the whole behaviour here,
 * so passing them in is what makes both contracts testable without a live tmux
 * pane: the navigation one ("walk toward the target, re-reading between presses;
 * refuse when the row vanished; give up rather than spin") and the route one
 * ("never poke a working session; validate before opening; always release").
 */
import {
  capturePane,
  sendKey as sendKeyLive,
  sendText as sendTextLive,
  pollPane,
  ensureMenuViewport,
} from "./send";
import { closePicker } from "./picker";
import { withPickerLock, pickerIdle } from "./pickerFlow";

/** Pane IO, injectable so the loops below can be driven against a fake pane. */
export interface PaneIO {
  capture: (target: string) => Promise<string>;
  key: (target: string, key: string) => Promise<void>;
  /** Type a literal string. Clears residual input first — NOT the same as `key`. */
  text: (target: string, text: string) => Promise<void>;
  close: (target: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
}

export const livePaneIO: PaneIO = {
  capture: (t) => capturePane(t),
  key: (t, k) => sendKeyLive(t, k),
  text: (t, s) => sendTextLive(t, s),
  close: (t) => closePicker(t),
  sleep: (ms) => Bun.sleep(ms),
};

/**
 * Why an open failed, given how the pane looked. Ordering matters: a picker that
 * reports the feature is unsupported is a different answer from one we simply
 * could not read, and a window pinned small by a LIVE attach is not our failure
 * to fix — we say so rather than claiming the menu was unreadable.
 */
export function openFailureReason(
  roomy: boolean,
  raw: string,
  unsupported?: RegExp,
): string {
  if (unsupported?.test(raw)) return "effort-unsupported";
  return roomy ? "menu-unreadable" : "attached-small";
}

/** Which arrow to press to move one step toward the target row. */
export function navKey(steps: number, keys: readonly [back: string, fwd: string]): string {
  return steps < 0 ? keys[0] : keys[1];
}

export type OpenResult<P> = { picker: P } | { reason: string };

export interface OpenSpec<P> {
  /** Put the picker on screen (viewport already ensured). */
  trigger: (target: string, io: PaneIO) => Promise<void>;
  /** Read the picker out of a capture; null = not there / not readable. */
  parse: (raw: string) => P | null;
  /** Marks the feature as unavailable in this build rather than unreadable. */
  unsupported?: RegExp;
}

/**
 * Open a picker and parse it. On failure it closes whatever it opened before
 * returning a reason — a half-open picker left behind would sit waiting on a
 * human who has no idea it is there, which is the exact failure peek-and-release
 * exists to prevent.
 */
export async function openPicker<P>(
  target: string,
  spec: OpenSpec<P>,
  io: PaneIO = livePaneIO,
  viewport: (t: string) => Promise<boolean> = ensureMenuViewport,
  poll: typeof pollPane = pollPane,
): Promise<OpenResult<P>> {
  const roomy = await viewport(target);
  await spec.trigger(target, io);
  await io.sleep(350);
  const picker = await poll(async () => spec.parse(await io.capture(target)));
  if (!picker) {
    const raw = spec.unsupported ? await io.capture(target) : "";
    await io.close(target);
    return { reason: openFailureReason(roomy, raw, spec.unsupported) };
  }
  return { picker };
}

/** A tries budget shared across the drive and confirm phases of one commit, so
 *  splitting them apart cannot widen the bound the single loop used to enforce. */
export interface Budget {
  left: number;
}

export type DriveOutcome<P> =
  /** `picker` is the ARRIVAL-time parse, not the open-time one — a confirm that
   *  reads the chosen row must read the list as it stands now, not as it stood
   *  before the walk. */
  | { ok: true; picker: P }
  | { ok: false; reason: "menu-unreadable" | "gone" | "stuck"; closed: boolean };

export interface DriveSpec<P> {
  parse: (raw: string) => P | null;
  /** How many rows the picker currently offers. */
  count: (p: P) => number;
  /** Where the cursor sits right now. */
  cursor: (p: P) => number;
  navKeys: readonly [back: string, fwd: string];
  /** Pause between a keypress and the next read, so Ink can redraw. */
  stepMs?: number;
}

/**
 * Walk the cursor onto row `idx`, re-reading the pane between presses.
 *
 * Closed-loop rather than "press N times": the TUI drops rapid presses under
 * load, and an open-loop count silently lands on the wrong row — which for a
 * destructive picker means restoring the wrong checkpoint. Re-reading also means
 * a row that disappeared mid-walk is caught (`gone`) instead of confirmed blind.
 */
export async function driveToRow<P>(
  target: string,
  idx: number,
  spec: DriveSpec<P>,
  budget: Budget,
  io: PaneIO = livePaneIO,
): Promise<DriveOutcome<P>> {
  while (budget.left > 0) {
    budget.left--;
    const picker = spec.parse(await io.capture(target));
    // Unreadable is left OPEN deliberately: we no longer know what is on screen,
    // and an Esc into an unknown state is the hazard closePicker exists to avoid.
    if (!picker) return { ok: false, reason: "menu-unreadable", closed: false };
    if (idx >= spec.count(picker)) {
      await io.close(target);
      return { ok: false, reason: "gone", closed: true };
    }
    const steps = idx - spec.cursor(picker);
    if (steps === 0) return { ok: true, picker };
    await io.key(target, navKey(steps, spec.navKeys));
    await io.sleep(spec.stepMs ?? 200);
  }
  return { ok: false, reason: "stuck", closed: false };
}

// ── the route shell ─────────────────────────────────────────────────────────

export interface PickerRouteSpec<P, C> {
  sessionId: string;
  target: string;
  /** "open" | "select" | "cancel", already matched out of the path. */
  action: string;
  req: Request;
  openSpec: OpenSpec<P>;
  drive: DriveSpec<P>;
  /** What /open ships to the client alongside `ok`. Defaults to the picker. */
  peek?: (p: P) => object;
  /**
   * Validate the commit body BEFORE anything is opened — a malformed choice must
   * not cost a picker open (and must not leave one standing).
   */
  choice: (body: unknown) => C | null;
  /** Resolve the validated choice against the FRESHLY parsed picker. <0 = gone. */
  locate: (picker: P, choice: C) => number;
  /** Cursor is on the row: confirm. Shares the drive's remaining tries budget. */
  confirm: (ctx: {
    target: string;
    io: PaneIO;
    picker: P;
    index: number;
    budget: Budget;
  }) => Promise<Response>;
  /** 502 reason when the loop never lands. */
  stuckReason: string;
  io?: PaneIO;
  /** Total pane reads one commit may spend across drive AND confirm. */
  tries?: number;
  idle?: (target: string) => Promise<boolean>;
  /** Seams `openPicker` needs. Threaded through so this function is reachable
   *  in a test without a live tmux pane — the defaults spawn one. */
  viewport?: (target: string) => Promise<boolean>;
  poll?: typeof pollPane;
}

/**
 * The peek-and-release flow shared by rewind / model / effort.
 *
 * `open` reads the options and immediately releases the picker, so the backend
 * is idle while the human deliberates and backing out strands nothing. `select`
 * re-opens and resolves the choice by identity, because the list may have moved
 * under us between peek and commit.
 */
export async function runPickerRoute<P, C>(spec: PickerRouteSpec<P, C>): Promise<Response> {
  const { sessionId, target, action, req } = spec;
  const io = spec.io ?? livePaneIO;
  const idle = spec.idle ?? pickerIdle;

  // Serialize every picker op for this session so a release Esc and a later
  // commit/cancel Esc can't interleave into the TUI's Esc-Esc rewind gesture.
  return withPickerLock(sessionId, async () => {
    try {
      if (action === "cancel") {
        // Esc only if a picker is actually open — footer-gated, so a bare prompt
        // or a thinking turn is never touched (drive/picker.ts).
        await io.close(target);
        return Response.json({ ok: true });
      }
      // Never open a picker on a mid-turn session — an Esc would interrupt it.
      if (!(await idle(target)))
        return Response.json({ ok: false, reason: "busy" }, { status: 409 });

      if (action === "open") {
        const r = await openPicker(target, spec.openSpec, io, spec.viewport, spec.poll);
        if ("reason" in r)
          return Response.json({ ok: false, reason: r.reason }, { status: 409 });
        await io.close(target); // release — never sit open waiting on the human
        return Response.json({ ok: true, ...(spec.peek ? spec.peek(r.picker) : r.picker) });
      }

      const choice = spec.choice(await req.json().catch(() => ({})));
      if (choice === null)
        return Response.json({ ok: false, reason: "bad-choice" }, { status: 400 });

      const r = await openPicker(target, spec.openSpec, io, spec.viewport, spec.poll);
      if ("reason" in r) return Response.json({ ok: false, reason: r.reason }, { status: 409 });

      const index = spec.locate(r.picker, choice);
      if (index < 0) {
        await io.close(target); // release — the row is gone or ambiguous
        return Response.json({ ok: false, reason: "gone" }, { status: 409 });
      }

      const budget: Budget = { left: spec.tries ?? 30 };
      const walked = await driveToRow(target, index, spec.drive, budget, io);
      if (!walked.ok) {
        if (walked.reason === "stuck")
          return Response.json({ ok: false, reason: spec.stuckReason }, { status: 502 });
        return Response.json({ ok: false, reason: walked.reason }, { status: 409 });
      }
      return spec.confirm({ target, io, picker: walked.picker, index, budget });
    } catch {
      return Response.json({ ok: false, reason: "send-failed" }, { status: 502 });
    }
  });
}
