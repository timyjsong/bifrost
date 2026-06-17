/**
 * Slash-command enumeration for the suggester (M7). Scans disk for the accurate
 * part — user commands in `<claudeDir>/commands`, skill dirs under
 * `<claudeDir>/skills`, and the session's project commands in
 * `<cwd>/.claude/commands` — and merges a static list of common built-ins
 * (baked into the binary, not on disk). This is deliberately NON-authoritative:
 * plugin/MCP-registered commands aren't enumerable here, and that's fine — the
 * suggester only accelerates; any command can be typed raw and sent.
 *
 * The cwd-independent part (built-ins + user commands + skills) is cached for a
 * slow cadence; the per-session project scan is cheap and runs each request.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SlashCommand } from "../../shared/types";

// Common Claude Code built-ins (a maintained static list — stable and few).
const BUILTINS = [
  "/clear", "/compact", "/config", "/cost", "/doctor", "/exit", "/help",
  "/init", "/mcp", "/memory", "/model", "/resume", "/review", "/status",
  "/vim", "/agents", "/add-dir", "/terminal-setup", "/login", "/logout",
];

async function scanCommands(
  dir: string,
  source: SlashCommand["source"],
): Promise<SlashCommand[]> {
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ name: "/" + f.replace(/\.md$/, ""), source }));
  } catch {
    return []; // dir doesn't exist — no commands of this kind
  }
}

async function scanSkills(dir: string): Promise<SlashCommand[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: "/" + e.name, source: "skill" as const }));
  } catch {
    return [];
  }
}

let cache: { at: number; cmds: SlashCommand[] } | null = null;

async function cwdIndependent(claudeDir: string, now: number): Promise<SlashCommand[]> {
  if (cache && now - cache.at < 30_000) return cache.cmds;
  const cmds: SlashCommand[] = [
    ...BUILTINS.map((name) => ({ name, source: "builtin" as const })),
    ...(await scanCommands(join(claudeDir, "commands"), "user")),
    ...(await scanSkills(join(claudeDir, "skills"))),
  ];
  cache = { at: now, cmds };
  return cmds;
}

/** All slash commands available to a session, deduped (first source wins). */
export async function slashFor(
  claudeDir: string,
  cwd: string,
  now: number,
): Promise<SlashCommand[]> {
  const global = await cwdIndependent(claudeDir, now);
  const project = await scanCommands(join(cwd, ".claude", "commands"), "project");
  const seen = new Set<string>();
  return [...global, ...project].filter((c) => !seen.has(c.name) && seen.add(c.name));
}
