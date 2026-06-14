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

export interface Snapshot {
  generatedAt: number;
  bundleId?: number; // dist/index.html mtime — frontend reloads when it changes
  summarize?: { active: string[]; queued: string[] }; // session ids being summarized
  projects: ProjectInfo[];
  sessions: SessionInfo[];
  system: SystemInfo;
}
