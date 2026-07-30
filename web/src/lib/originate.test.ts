import { describe, expect, test } from "bun:test";
import {
  MAX_NAME_LEN,
  ORIGINATE_MODELS,
  validateOriginate,
  type OriginateForm,
} from "./originate";

const base: OriginateForm = { cwd: "/home/you/proj", model: "opus", name: "" };

// ── AC5.1 — picker validation (cwd / model / optional name) ────────────────────
describe("AC5.1 validateOriginate", () => {
  test("the four pickable models are offered with display labels", () => {
    expect(ORIGINATE_MODELS.map((m) => m.alias)).toEqual(["opus", "sonnet", "haiku", "fable"]);
    for (const m of ORIGINATE_MODELS) expect(m.label.length).toBeGreaterThan(0);
  });

  test("a well-formed form (cwd under root, allowlisted model, no name) is startable", () => {
    expect(validateOriginate(base)).toEqual({ ok: true });
  });

  test("an optional name within bounds is accepted", () => {
    expect(validateOriginate({ ...base, name: "nightly build" })).toEqual({ ok: true });
  });

  test("an empty or relative cwd is rejected on the cwd field", () => {
    expect(validateOriginate({ ...base, cwd: "" })).toMatchObject({ ok: false, field: "cwd" });
    expect(validateOriginate({ ...base, cwd: "   " })).toMatchObject({ ok: false, field: "cwd" });
    expect(validateOriginate({ ...base, cwd: "proj" })).toMatchObject({ ok: false, field: "cwd" });
  });

  test("a model off the allowlist is rejected on the model field", () => {
    expect(validateOriginate({ ...base, model: "gpt-4o" })).toMatchObject({
      ok: false,
      field: "model",
    });
    expect(validateOriginate({ ...base, model: "" })).toMatchObject({ ok: false, field: "model" });
  });

  test("an over-long or multi-line name is rejected on the name field", () => {
    expect(validateOriginate({ ...base, name: "a".repeat(MAX_NAME_LEN + 1) })).toMatchObject({
      ok: false,
      field: "name",
    });
    expect(validateOriginate({ ...base, name: "line1\nline2" })).toMatchObject({
      ok: false,
      field: "name",
    });
  });

  test("a name at exactly the bound is accepted (boundary)", () => {
    expect(validateOriginate({ ...base, name: "a".repeat(MAX_NAME_LEN) })).toEqual({ ok: true });
  });
});

// ── new-session picker — root + optional subfolder compose the cwd ─────────────
