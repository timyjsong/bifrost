/**
 * Guard for the /effort slider's side effect. Verified live (2026-07-02, CC
 * v2.1.198): confirming the slider both latches the SESSION's effort (held
 * independently of the file) AND rewrites `effortLevel` in the account
 * ~/.claude/settings.json ("saved as your default for new sessions"). Bifrost's
 * effort control is session-scoped, so after driving the slider it restores the
 * account default it read beforehand — compare-and-swap: only a move to exactly
 * the value we selected is ours to undo; anything else (a concurrent edit by
 * the user) is left alone.
 */
import { join } from "node:path";

const settingsFile = (claudeDir: string) => join(claudeDir, "settings.json");

/** Should the account default be restored? Ours to undo iff it moved away from
 *  `prior` to exactly what we selected. No `prior` key → nothing to restore to. */
export function shouldRestoreEffortDefault(
  prior: string | undefined,
  now: string | undefined,
  selected: string,
): boolean {
  return prior !== undefined && now !== prior && now === selected;
}

/** Surgical value swap — the file is user-owned config, so everything but the
 *  effortLevel value (formatting, key order) is preserved byte-for-byte.
 *  Returns the original text unchanged if the key isn't present. */
export function replaceEffortLevel(text: string, level: string): string {
  if (!/^[a-z]+$/.test(level)) return text; // slider labels only — never inject
  return text.replace(/("effortLevel"\s*:\s*")[^"]*(")/, `$1${level}$2`);
}

export async function readEffortLevel(claudeDir: string): Promise<string | undefined> {
  try {
    const j = JSON.parse(await Bun.file(settingsFile(claudeDir)).text()) as {
      effortLevel?: unknown;
    };
    return typeof j.effortLevel === "string" ? j.effortLevel : undefined;
  } catch {
    return undefined;
  }
}

export async function restoreEffortLevel(claudeDir: string, prior: string): Promise<void> {
  const f = settingsFile(claudeDir);
  const text = await Bun.file(f).text();
  const restored = replaceEffortLevel(text, prior);
  if (restored !== text) await Bun.write(f, restored);
}
