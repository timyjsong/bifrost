import { describe, expect, test } from "bun:test";
import {
  driveToRow,
  navKey,
  openFailureReason,
  openPicker,
  runPickerRoute,
  type Budget,
  type PickerRouteSpec,
  type PaneIO,
} from "./pickerRoute";

// A fake picker: a list of rows plus where the cursor sits. The fake pane
// renders it to a string, so the parser under test is a real string parse.
interface Fake {
  rows: string[];
  cursor: number;
}
const render = (f: Fake) =>
  f.rows.map((r, i) => `${i === f.cursor ? "❯" : " "} ${r}`).join("\n");
const parse = (raw: string): Fake | null => {
  const lines = raw.split("\n").filter((l) => /^[❯ ] /.test(l));
  if (!lines.length) return null;
  const cursor = lines.findIndex((l) => l.startsWith("❯"));
  return cursor < 0 ? null : { rows: lines.map((l) => l.slice(2)), cursor };
};

/** A pane that moves its own cursor in response to Up/Down, like the TUI does. */
function fakePane(initial: Fake, opts: { dropPresses?: number; blankAfter?: number } = {}) {
  const state: Fake = { rows: [...initial.rows], cursor: initial.cursor };
  const keys: string[] = [];
  let reads = 0;
  let dropped = 0;
  const io: PaneIO = {
    capture: async () => {
      reads++;
      if (opts.blankAfter !== undefined && reads > opts.blankAfter) return "";
      return render(state);
    },
    text: async (_t, s) => {
      keys.push(`text:${s}`);
    },
    key: async (_t, k) => {
      keys.push(k);
      if (dropped < (opts.dropPresses ?? 0)) {
        dropped++; // the TUI swallowed this press
        return;
      }
      if (k === "Up") state.cursor = Math.max(0, state.cursor - 1);
      if (k === "Down") state.cursor = Math.min(state.rows.length - 1, state.cursor + 1);
    },
    close: async () => {
      state.rows = [];
      return true;
    },
    sleep: async () => {},
  };
  return { io, state, keys };
}

const spec = {
  parse,
  count: (f: Fake) => f.rows.length,
  cursor: (f: Fake) => f.cursor,
  navKeys: ["Up", "Down"] as const,
  stepMs: 0,
};
const budget = (n = 30): Budget => ({ left: n });

describe("navKey", () => {
  test("negative steps walk back, positive walk forward", () => {
    expect(navKey(-3, ["Up", "Down"])).toBe("Up");
    expect(navKey(2, ["Up", "Down"])).toBe("Down");
    expect(navKey(-1, ["Left", "Right"])).toBe("Left");
    expect(navKey(4, ["Left", "Right"])).toBe("Right");
  });
});

describe("openFailureReason", () => {
  test("a roomy window that would not parse is an unreadable menu", () => {
    expect(openFailureReason(true, "whatever")).toBe("menu-unreadable");
  });

  test("a window pinned small by a live attach says so instead", () => {
    expect(openFailureReason(false, "whatever")).toBe("attached-small");
  });

  test("an unsupported feature beats both — it is not a reading problem", () => {
    const pat = /not supported/i;
    expect(openFailureReason(true, "effort is not supported here", pat)).toBe(
      "effort-unsupported",
    );
    expect(openFailureReason(false, "effort is NOT SUPPORTED", pat)).toBe(
      "effort-unsupported",
    );
  });
});

describe("driveToRow", () => {
  test("walks forward to the target and stops on it", async () => {
    const { io, state, keys } = fakePane({ rows: ["a", "b", "c", "d"], cursor: 0 });
    const r = await driveToRow("t", 3, spec, budget(), io);
    expect(r.ok).toBe(true);
    expect(state.cursor).toBe(3);
    expect(keys).toEqual(["Down", "Down", "Down"]);
  });

  test("walks backward too", async () => {
    const { io, state, keys } = fakePane({ rows: ["a", "b", "c", "d"], cursor: 3 });
    const r = await driveToRow("t", 1, spec, budget(), io);
    expect(r.ok).toBe(true);
    expect(state.cursor).toBe(1);
    expect(keys).toEqual(["Up", "Up"]);
  });

  test("already on the target presses nothing", async () => {
    const { io, keys } = fakePane({ rows: ["a", "b"], cursor: 1 });
    const r = await driveToRow("t", 1, spec, budget(), io);
    expect(r.ok).toBe(true);
    expect(keys).toEqual([]);
  });

  // The whole reason this is closed-loop rather than "press N times".
  test("a dropped keypress is recovered — it re-reads and presses again", async () => {
    const { io, state, keys } = fakePane({ rows: ["a", "b", "c"], cursor: 0 }, { dropPresses: 2 });
    const r = await driveToRow("t", 2, spec, budget(), io);
    expect(r.ok).toBe(true);
    expect(state.cursor).toBe(2);
    expect(keys.length).toBe(4); // 2 swallowed + 2 that landed
  });

  // Rewind is destructive: a row that vanished mid-walk must never be confirmed.
  test("a target beyond the current rows is 'gone', and the picker is closed", async () => {
    const { io } = fakePane({ rows: ["a", "b"], cursor: 0 });
    const r = await driveToRow("t", 5, spec, budget(), io);
    expect(r).toEqual({ ok: false, reason: "gone", closed: true });
  });

  // An unreadable pane is left OPEN — we no longer know what is on screen, and a
  // blind Esc into an unknown state is the hazard closePicker exists to avoid.
  test("an unreadable pane reports menu-unreadable and does NOT close", async () => {
    const { io } = fakePane({ rows: ["a", "b"], cursor: 0 }, { blankAfter: 0 });
    const r = await driveToRow("t", 1, spec, budget(), io);
    expect(r).toEqual({ ok: false, reason: "menu-unreadable", closed: false });
  });

  test("gives up rather than spinning when the cursor never lands", async () => {
    // Every press is swallowed, so the cursor never reaches the target.
    const { io, keys } = fakePane({ rows: ["a", "b", "c"], cursor: 0 }, { dropPresses: 999 });
    const r = await driveToRow("t", 2, spec, budget(4), io);
    expect(r).toEqual({ ok: false, reason: "stuck", closed: false });
    expect(keys.length).toBe(4); // exactly the budget, no more
  });

  // The confirm step may read the chosen row (effort does, to decide whether to
  // restore the account default), so it must get the list as it stands ON
  // ARRIVAL, not the stale one read before the walk began.
  test("returns the arrival-time parse, not the open-time one", async () => {
    const { io, state } = fakePane({ rows: ["a", "b", "c"], cursor: 0 });
    // The list grows while the cursor is being walked.
    const orig = io.capture;
    let n = 0;
    io.capture = async (t: string) => {
      if (n++ === 1) state.rows.push("d");
      return orig(t);
    };
    const r = await driveToRow("t", 2, spec, budget(), io);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.picker.rows).toEqual(["a", "b", "c", "d"]);
  });

  test("the budget is consumed, so a caller can share it with a confirm phase", async () => {
    const { io } = fakePane({ rows: ["a", "b", "c"], cursor: 0 });
    const b = budget(30);
    await driveToRow("t", 2, spec, b, io);
    expect(b.left).toBe(27); // 3 reads: two moves + the arrival read
  });
});

describe("openPicker", () => {
  const trigger = async () => {};

  test("returns the parsed picker once it renders", async () => {
    const { io } = fakePane({ rows: ["a", "b"], cursor: 0 });
    const r = await openPicker(
      "t",
      { trigger, parse },
      io,
      async () => true,
      async (read) => await read(),
    );
    expect(r).toEqual({ picker: { rows: ["a", "b"], cursor: 0 } });
  });

  test("a picker that never parses is closed, not left half-open", async () => {
    const { io, state } = fakePane({ rows: ["a"], cursor: 0 }, { blankAfter: 0 });
    const r = await openPicker(
      "t",
      { trigger, parse },
      io,
      async () => true,
      async (read) => await read(),
    );
    expect(r).toEqual({ reason: "menu-unreadable" });
    expect(state.rows).toEqual([]); // close() ran
  });

  test("a small attached window is reported as such, not as unreadable", async () => {
    const { io } = fakePane({ rows: ["a"], cursor: 0 }, { blankAfter: 0 });
    const r = await openPicker(
      "t",
      { trigger, parse },
      io,
      async () => false, // ensureMenuViewport could not resize — live attach
      async (read) => await read(),
    );
    expect(r).toEqual({ reason: "attached-small" });
  });

  test("an unsupported feature is distinguished from an unreadable one", async () => {
    const io: PaneIO = {
      capture: async () => "effort is not supported in this build",
      key: async () => {},
      text: async () => {},
      close: async () => true,
      sleep: async () => {},
    };
    const r = await openPicker(
      "t",
      { trigger, parse, unsupported: /not supported/i },
      io,
      async () => true,
      async (read) => await read(),
    );
    expect(r).toEqual({ reason: "effort-unsupported" });
  });
});

// ── runPickerRoute: the route contract, not just the walk ───────────────────
// This is the function the refactor was named for, and it was the one part with
// no coverage — its openPicker call did not thread the viewport/poll seams, so
// reaching it meant spawning tmux. Those are threaded now, so the branches that
// matter (never poke a working session, validate before opening, always
// release) can be asserted.
describe("runPickerRoute", () => {
  const openSpec = { trigger: async () => {}, parse };
  const drive = {
    parse,
    count: (f: Fake) => f.rows.length,
    cursor: (f: Fake) => f.cursor,
    navKeys: ["Up", "Down"] as const,
    stepMs: 0,
  };
  const post = (body: unknown) =>
    new Request("http://x/api/session/s/model/select", {
      method: "POST",
      body: JSON.stringify(body),
    });

  const run = (
    action: string,
    over: Partial<PickerRouteSpec<Fake, string>> = {},
    pane = fakePane({ rows: ["a", "b", "c"], cursor: 0 }),
  ) => ({
    pane,
    res: runPickerRoute<Fake, string>({
      sessionId: `s-${action}-${Math.abs(action.length * 7)}`,
      target: "t",
      action,
      req: post({ pick: "c" }),
      openSpec,
      drive,
      choice: (b) => {
        const o = b as { pick?: unknown };
        return typeof o.pick === "string" ? o.pick : null;
      },
      locate: (p: Fake, c: string) => p.rows.indexOf(c),
      confirm: async ({ io, target }) => {
        await io.key(target, "Enter");
        return Response.json({ ok: true, confirmed: true });
      },
      stuckReason: "cursor-stuck",
      io: pane.io,
      idle: async () => true,
      viewport: async () => true,
      poll: (async (read: () => Promise<unknown>) => await read()) as never,
      ...over,
    }),
  });

  test("cancel closes the picker and never checks whether the pane is idle", async () => {
    let idleChecked = false;
    const { pane, res } = run("cancel", { idle: async () => ((idleChecked = true), true) });
    expect(await (await res).json()).toEqual({ ok: true });
    expect(idleChecked).toBe(false); // closePicker is footer-gated; safe unconditionally
    expect(pane.state.rows).toEqual([]); // close() ran
  });

  // An Esc into a live turn would interrupt it. This is the guard that stops it.
  test("a working session is refused 409 busy, and nothing is opened", async () => {
    const { pane, res } = run("open", { idle: async () => false });
    const r = await res;
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ ok: false, reason: "busy" });
    expect(pane.keys).toEqual([]); // no trigger, no keystrokes at all
  });

  test("open peeks the options and RELEASES — it never sits open on the human", async () => {
    const { pane, res } = run("open");
    const body = (await (await res).json()) as { ok: boolean; rows: string[] };
    expect(body.ok).toBe(true);
    expect(body.rows).toEqual(["a", "b", "c"]);
    expect(pane.state.rows).toEqual([]); // released
  });

  // Validation happens BEFORE the open, so a malformed choice cannot cost a
  // picker open — nor leave one standing.
  test("a malformed choice is 400 and no picker is ever opened", async () => {
    const { pane, res } = run("select", { req: post({ nope: 1 }) });
    const r = await res;
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ ok: false, reason: "bad-choice" });
    expect(pane.keys).toEqual([]);
  });

  test("a choice that is no longer offered is 409 gone, and the picker is released", async () => {
    const { pane, res } = run("select", { req: post({ pick: "zzz" }) });
    const r = await res;
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ ok: false, reason: "gone" });
    expect(pane.state.rows).toEqual([]);
  });

  test("a valid choice walks to the row and confirms", async () => {
    const { pane, res } = run("select");
    expect(await (await res).json()).toEqual({ ok: true, confirmed: true });
    expect(pane.keys).toEqual(["Down", "Down", "Enter"]);
  });

  test("a pane that will not parse is 409, not a guessed keystroke", async () => {
    const pane = fakePane({ rows: ["a"], cursor: 0 }, { blankAfter: 0 });
    const { res } = run("open", {}, pane);
    const r = await res;
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ ok: false, reason: "menu-unreadable" });
  });

  // A throw from the pane must not escape as an unhandled 500.
  test("an IO failure becomes a clean 502, not an exception", async () => {
    const pane = fakePane({ rows: ["a", "b", "c"], cursor: 0 });
    pane.io.capture = async () => {
      throw new Error("tmux vanished");
    };
    const { res } = run("select", {}, pane);
    const r = await res;
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ ok: false, reason: "send-failed" });
  });
});
