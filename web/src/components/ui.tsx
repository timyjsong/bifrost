import type { ReactNode } from "react";

export function PaperclipIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[18px]"
    >
      <path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.49 8.49a2 2 0 0 1-2.83-2.83l7.78-7.78" />
    </svg>
  );
}

export function Panel({
  children,
  className = "",
  interactive = false,
}: {
  children: ReactNode;
  className?: string;
  /** hover treatment for panels the eye should be invited into */
  interactive?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border border-line-soft bg-panel/70 backdrop-blur-sm ${
        interactive
          ? "transition-[border-color,background-color,box-shadow] duration-200 hover:border-line hover:bg-panel-raised/70 hover:shadow-[0_10px_30px_-18px_rgba(0,0,0,0.9)]"
          : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  title,
  hint,
  right,
}: {
  title: string;
  hint?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-4">
      <div className="flex items-baseline gap-3">
        <h2 className="text-[13px] font-medium uppercase tracking-[0.18em] text-ink-dim">
          {title}
        </h2>
        {hint && <span className="text-xs text-ink-mute">{hint}</span>}
      </div>
      {right}
    </div>
  );
}

export function Chip({
  children,
  tone = "mute",
  mono = false,
}: {
  children: ReactNode;
  tone?: "mute" | "gold" | "auto" | "danger" | "tmux" | "ssh" | "desk";
  mono?: boolean;
}) {
  const tones: Record<string, string> = {
    mute: "border-line text-ink-mute",
    gold: "border-gold-dim/60 text-gold",
    auto: "border-auto/40 text-auto",
    danger: "border-danger/50 text-danger",
    // residence family: tinted fill marks "where it runs" at a glance
    tmux: "border-tmux/40 bg-tmux/10 text-tmux",
    ssh: "border-ssh/40 bg-ssh/10 text-ssh",
    desk: "border-desk/40 bg-desk/10 text-desk",
  };
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-px text-[11px] leading-4 ${tones[tone]} ${mono ? "font-mono" : ""}`}
    >
      {children}
    </span>
  );
}

export function Dot({
  tone,
  pulse = false,
}: {
  tone: "gold" | "auto" | "mute" | "danger";
  pulse?: boolean;
}) {
  const tones: Record<string, string> = {
    gold: "bg-gold",
    auto: "bg-auto",
    mute: "bg-ink-mute",
    danger: "bg-danger",
  };
  return (
    <span
      className={`inline-block size-[7px] shrink-0 rounded-full ${tones[tone]} ${pulse ? "pulse-dot" : ""}`}
    />
  );
}

export function Bar({
  ratio,
  tone = "gold",
  className = "",
}: {
  ratio: number; // 0..1
  tone?: "gold" | "danger" | "dim";
  className?: string;
}) {
  const tones: Record<string, string> = {
    gold: "bg-gold",
    danger: "bg-danger",
    dim: "bg-ink-dim",
  };
  const w = Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <div className={`h-[3px] overflow-hidden rounded-full bg-line ${className}`}>
      <div
        className={`h-full rounded-full ${tones[tone]} transition-[width] duration-700 ease-out`}
        style={{ width: `${w}%` }}
      />
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  children,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Panel className="px-4 py-3">
      <div className="text-[10.5px] uppercase tracking-[0.16em] text-ink-mute">
        {label}
      </div>
      <div className="mt-1.5 font-mono text-[20px] leading-tight text-ink tabular-nums">
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-ink-mute">{sub}</div>}
      {children}
    </Panel>
  );
}
