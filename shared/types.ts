export interface SessionInfo {
  sessionId: string;
  pid?: number;
  live: boolean;
  kind?: string; // "interactive" | other (print/headless variants)
  status?: string;
  entrypoint?: string; // "cli" | "claude-desktop" | "sdk-cli" | ...
  headless?: boolean; // entrypoint is sdk-driven (eval probes, programmatic runs)
  cwd: string;
  title?: string;
  customTitle?: string; // the name the user gave the session (rename)
  gitBranch?: string;
  model?: string;
  startedAt?: number; // epoch ms
  lastActivityAt: number; // epoch ms
  contextTokens?: number;
  contextWindow?: number; // resolved window size (live sessions; switch-aware)
  contextWindowSrc?:
    | "model-log"
    | "launch-flag"
    | "saved-default"
    | "last-model-usage"
    | "token-floor"
    | "lookup";
  transcriptBytes?: number;
  // live-session activity state (derived; live interactive sessions only)
  state?: "awaiting" | "approval" | "paused" | "working";
  lastPromptAt?: number; // when the user last typed — anchors the in-progress timer
  // where the session lives (derived from /proc + tmux; live interactive only)
  tmuxSession?: string; // tmux session name, if running inside a pane
  tmuxAttached?: boolean; // that tmux session has a client attached right now
  overSsh?: boolean; // hangs off a live sshd — dies with the connection
  childProcs?: number;
  children?: ChildProc[]; // leaf subprocesses currently running under this session
  alertsEnabled?: boolean; // per-card mute (default on); false = no session alerts fire
  nowDoing?: string; // last assistant text snippet
}

export interface ChildProc {
  pid: number;
  etime: string;
  rssKb: number;
  cpu: number; // % of total box CPU (all cores = 100), since last tick
  command: string;
  name?: string; // the description the session gave this background task
}

export interface ProjectGit {
  branch: string;
  dirty: number;
  lastCommitMsg: string;
  lastCommitAt: number; // epoch ms
}

export interface ProjectInfo {
  name: string;
  realm: string;
  path: string;
  blurb?: string;
  git?: ProjectGit;
  lastActivityAt: number;
  liveSessions: number;
  recentSessions: number;
}

export interface FileEntry {
  name: string;
  type: "dir" | "file" | "symlink" | "other";
  size: number; // bytes (lstat — symlinks report the link's own size)
  mtimeMs: number;
}

export interface DirListing {
  path: string; // canonical (realpath'd) directory that was listed
  entries: FileEntry[];
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  user: string;
  rssKb: number;
  cpu: number; // % of total box CPU (all cores = 100), since last tick
  etime: string;
  tty?: string; // controlling terminal ("pts/2"), if any
  command: string;
  isClaude: boolean;
}

export interface TmuxInfo {
  name: string;
  windows: number;
  createdAt: number; // epoch ms
  attached: boolean;
}

export interface PortInfo {
  addr: string;
  port: number;
  process?: string;
}

export interface SystemInfo {
  hostname: string;
  uptimeSec: number;
  load: [number, number, number];
  cpuPct?: number; // real utilization from /proc/stat deltas (first tick: undefined)
  disk: { totalKb: number; freeKb: number }; // root filesystem
  cores: number;
  mem: {
    totalKb: number;
    availKb: number;
    swapTotalKb: number;
    swapFreeKb: number;
  };
  procs: ProcInfo[];
  claudeTotalRssKb: number;
  tmux: TmuxInfo[];
  ports: PortInfo[];
}

// --- Bidirectional drive: normalized interaction state (Build 1 / phases/01) ---
// A session's transcript reduced to ordered messages + content blocks. Build 1
// renders it linearly; `isSidechain` preserves the subagent topology so Build 3's
// background-tasks view can render the tree without a re-parse (epic principle 5).
export type ContentBlock =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; forId: string; text: string; isError: boolean };

export interface InteractionMessage {
  uuid: string;
  role: "user" | "assistant";
  isSidechain: boolean; // a subagent turn (topology marker, not flattened away)
  blocks: ContentBlock[];
  ts: number; // epoch ms (0 if the entry carried no timestamp)
}

export interface InteractionState {
  sessionId: string;
  messages: InteractionMessage[];
}

// Channel 3 — ephemeral pane state (a pending permission menu), read live via
// capture-pane. `menu` is null when none is detected; `raw` is a pane tail for
// the loud fallback when a prompt seems active but couldn't be parsed.
export interface PermissionMenu {
  prompt: string;
  options: { key: string; label: string }[];
}

/** Claude TUI permission modes reachable mid-session via Shift+Tab (verified by
 *  spike). Bypass is launch-only and intentionally absent. The array order IS the
 *  Shift+Tab cycle order — used to compute how many presses reach a target. */
export type PermissionMode = "auto" | "accept-edits" | "plan";
export const PERMISSION_MODES: PermissionMode[] = ["auto", "accept-edits", "plan"];
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  auto: "auto",
  "accept-edits": "accept edits",
  plan: "plan",
};

export interface PaneState {
  drivable: boolean; // the session is tmux-resident (can be answered)
  menu: PermissionMenu | null;
  raw: string;
  working: boolean; // the MAIN turn is in flight (live pane — control not yours yet)
  pendingSend: boolean; // a send is parked server-side (grace window) — any device
  mode: PermissionMode | null; // current permission mode read off the pane (null if unknown)
}

// A slash command the suggester can offer. Non-authoritative: built-ins are a
// static list and plugin/MCP commands aren't enumerated — you can always type any
// command raw and send it.
export interface SlashCommand {
  name: string; // includes the leading slash, e.g. "/clear"
  source: "builtin" | "user" | "project" | "skill";
}

export interface Snapshot {
  generatedAt: number;
  bundleId?: number; // dist/index.html mtime — frontend reloads when it changes
  summarize?: { active: string[]; queued: string[] }; // session ids being summarized
  projects: ProjectInfo[];
  sessions: SessionInfo[];
  system: SystemInfo;
}
