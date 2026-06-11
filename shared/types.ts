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
  gitBranch?: string;
  model?: string;
  startedAt?: number; // epoch ms
  lastActivityAt: number; // epoch ms
  contextTokens?: number;
  transcriptBytes?: number;
  // live-session activity state (derived; live interactive sessions only)
  state?: "awaiting" | "approval" | "paused" | "working";
  childProcs?: number;
  children?: ChildProc[]; // leaf subprocesses currently running under this session
  nowDoing?: string; // last assistant text snippet
}

export interface ChildProc {
  pid: number;
  etime: string;
  rssKb: number;
  cpu: number;
  command: string;
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
  cpu: number;
  etime: string;
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
  projects: ProjectInfo[];
  sessions: SessionInfo[];
  system: SystemInfo;
}
