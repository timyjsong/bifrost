import { useEffect, useRef, useState } from "react";
import {
  CATALOG,
  type AlertPolicy,
  type RecentAlert,
  type SignalDef,
  type SignalPolicy,
} from "../../../shared/alerts";
import {
  cachedPolicy,
  classifyPushStatus,
  currentSubscription,
  detectEnv,
  disableAlerts,
  enableAlerts,
  fetchPolicy,
  fetchRecentAlerts,
  registerServiceWorker,
  savePolicy,
  sendTestPush,
  type PushStatus,
} from "../lib/push";
import { relTime } from "../lib/format";
import { Chip, Dot, Panel, SectionTitle } from "./ui";

const SEV_TONE: Record<RecentAlert["severity"], "mute" | "gold" | "danger"> = {
  info: "mute",
  warn: "gold",
  crit: "danger",
};

function RecentFeed({ alerts, now }: { alerts: RecentAlert[]; now: number }) {
  return (
    <Panel className="mb-3">
      <div className="border-b border-line-soft px-4 py-2 text-[11px] uppercase tracking-[0.14em] text-ink-mute">
        recent
        <span className="ml-2 normal-case tracking-normal text-ink-mute/70">
          what fired — a record even if the push was missed
        </span>
      </div>
      {alerts.length === 0 && (
        <div className="px-4 py-4 text-[12px] text-ink-mute">nothing fired yet</div>
      )}
      {alerts.map((a) => {
        const deepLink = a.instance
          ? () => window.location.assign(`/?session=${encodeURIComponent(a.instance!)}`)
          : undefined;
        return (
          <div
            key={`${a.firedAt}-${a.id}-${a.instance ?? ""}`}
            onClick={deepLink}
            className={`flex items-center gap-3 border-b border-line-soft px-4 py-2 text-[12px] last:border-b-0 ${
              deepLink ? "cursor-pointer hover:bg-panel-raised/60" : ""
            }`}
          >
            <Dot tone={SEV_TONE[a.severity]} />
            <span className="min-w-0 flex-1">
              <span className="text-ink-dim">{a.title}</span>
              <span className="ml-2 text-ink-mute">{a.body}</span>
            </span>
            <span className="shrink-0 font-mono text-[11px] text-ink-mute/70 tabular-nums">
              {relTime(a.firedAt, now)}
            </span>
          </div>
        );
      })}
    </Panel>
  );
}

const COOLDOWNS: Array<{ sec: number; label: string }> = [
  { sec: 30, label: "30s" },
  { sec: 60, label: "1m" },
  { sec: 300, label: "5m" },
  { sec: 600, label: "10m" },
  { sec: 1800, label: "30m" },
  { sec: 3600, label: "1h" },
];

const TIER_LABEL: Record<number, string> = {
  0: "Tier 0 · safety net",
  1: "Tier 1 · pressure",
  2: "Tier 2 · operations",
  3: "Tier 3 · lifecycle",
};

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      role="switch"
      aria-checked={on}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors ${
        on ? "bg-gold/80" : "bg-line"
      }`}
    >
      <span
        className={`absolute top-[2px] size-[14px] rounded-full bg-bg transition-[left] ${
          on ? "left-[16px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}

function SignalRow({
  def,
  pol,
  onChange,
}: {
  def: SignalDef;
  pol: SignalPolicy;
  onChange: (patch: Partial<SignalPolicy>) => void;
}) {
  return (
    <div
      className={`border-b border-line-soft px-4 py-3 last:border-b-0 ${
        pol.enabled ? "" : "opacity-55"
      }`}
    >
      <div className="flex items-center gap-3">
        <Toggle on={pol.enabled} onClick={() => onChange({ enabled: !pol.enabled })} />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-[13px] text-ink">{def.label}</span>
          <span className="min-w-0 truncate text-[12px] text-ink-mute">{def.desc}</span>
        </div>
        <select
          value={pol.cooldownSec}
          onChange={(e) => onChange({ cooldownSec: Number(e.target.value) })}
          className="shrink-0 rounded-md border border-line-soft bg-panel px-1.5 py-0.5 font-mono text-[11px] text-ink-dim"
          title="cooldown between repeats"
        >
          {COOLDOWNS.map((c) => (
            <option key={c.sec} value={c.sec}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      {def.threshold && (
        <div className="mt-2 flex items-center gap-3 pl-11">
          <span className="min-w-0 truncate text-[10.5px] uppercase tracking-[0.12em] text-ink-mute">
            {def.threshold.label}
          </span>
          <input
            type="range"
            min={def.threshold.min}
            max={def.threshold.max}
            step={def.threshold.step}
            value={pol.threshold ?? def.defaultThreshold ?? def.threshold.min}
            onChange={(e) => onChange({ threshold: Number(e.target.value) })}
            className="h-1 min-w-[5rem] flex-1 accent-gold"
          />
          <span className="shrink-0 text-right font-mono text-[11.5px] text-ink-dim tabular-nums">
            {pol.threshold ?? def.defaultThreshold} {def.threshold.unit}
          </span>
        </div>
      )}
    </div>
  );
}

function EnableBar({
  status,
  busy,
  onEnable,
  onDisable,
  onTest,
}: {
  status: PushStatus;
  busy: boolean;
  onEnable: () => void;
  onDisable: () => void;
  onTest: () => void;
}) {
  const btn =
    "rounded-md border px-3 py-1 text-[12px] transition-colors disabled:opacity-50";
  if (status === "subscribed") {
    return (
      <div className="flex items-center gap-3">
        <Chip tone="gold">alerts on</Chip>
        <button
          onClick={onTest}
          disabled={busy}
          className={`${btn} border-line text-ink-dim hover:bg-panel-raised`}
        >
          Send test
        </button>
        <button
          onClick={onDisable}
          disabled={busy}
          className={`${btn} border-line text-ink-mute hover:bg-panel-raised`}
        >
          Turn off
        </button>
      </div>
    );
  }
  if (status === "default") {
    return (
      <button
        onClick={onEnable}
        disabled={busy}
        className={`${btn} border-gold-dim/70 bg-gold/10 text-gold hover:bg-gold/20`}
      >
        Enable alerts on this device
      </button>
    );
  }
  const msg: Record<string, string> = {
    "needs-homescreen": "Add Bifrost to your Home Screen first, then enable alerts.",
    denied: "Notifications are blocked — turn them back on in your browser/site settings.",
    unsupported: "This browser can't deliver push notifications.",
  };
  return <span className="text-[12px] text-ink-mute">{msg[status]}</span>;
}

export function AlertsPane({ now }: { now: number }) {
  const [status, setStatus] = useState<PushStatus>("unsupported");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>("");
  const [policy, setPolicy] = useState<AlertPolicy | null>(cachedPolicy());
  const [recent, setRecent] = useState<RecentAlert[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function refreshStatus() {
    const sub = await currentSubscription().catch(() => null);
    setStatus(classifyPushStatus(detectEnv(!!sub)));
  }

  useEffect(() => {
    void registerServiceWorker().then(refreshStatus);
    void fetchPolicy()
      .then(setPolicy)
      .catch(() => {
        /* offline — the localStorage cache (already in state) stands in */
      });
  }, []);

  useEffect(() => {
    const load = () => void fetchRecentAlerts().then(setRecent).catch(() => {});
    load();
    const t = setInterval(load, 10_000); // alerts are low-frequency
    return () => clearInterval(t);
  }, []);

  function update(id: string, patch: Partial<SignalPolicy>) {
    setPolicy((prev) => {
      if (!prev) return prev;
      const nextSignal = { ...prev.signals[id], ...patch };
      const next: AlertPolicy = { ...prev, signals: { ...prev.signals, [id]: nextSignal } };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void savePolicy(next).catch(() => {}), 500);
      return next;
    });
  }

  async function onEnable() {
    setBusy(true);
    setNote("");
    const r = await enableAlerts().catch((e) => ({ ok: false, reason: String(e) }));
    if (!r.ok) setNote(r.reason === "denied" ? "" : `Couldn't enable: ${r.reason ?? "unknown"}`);
    await refreshStatus();
    setBusy(false);
  }

  async function onDisable() {
    setBusy(true);
    await disableAlerts().catch(() => {});
    await refreshStatus();
    setBusy(false);
  }

  async function onTest() {
    setBusy(true);
    const r = await sendTestPush().catch(() => ({ sent: 0, pruned: 0 }));
    setNote(r.sent ? `Test sent to ${r.sent} device${r.sent === 1 ? "" : "s"}.` : "No device received it.");
    setBusy(false);
  }

  const byTier = [0, 1, 2, 3] as const;

  return (
    <section id="alerts" className="scroll-mt-[72px]">
      <SectionTitle
        title="Alerts"
        hint="push notifications — tune live; defaults are a starting point"
      />

      <Panel className="mb-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <EnableBar
            status={status}
            busy={busy}
            onEnable={onEnable}
            onDisable={onDisable}
            onTest={onTest}
          />
          {note && <span className="text-[11.5px] text-ink-mute">{note}</span>}
        </div>
      </Panel>

      <RecentFeed alerts={recent} now={now} />

      {policy &&
        byTier.map((tier) => {
          const defs = CATALOG.filter((d) => d.tier === tier);
          if (!defs.length) return null;
          return (
            <div key={tier} className="mb-3">
              <div className="mb-1.5 px-1 text-[10.5px] uppercase tracking-[0.16em] text-ink-mute">
                {TIER_LABEL[tier]}
              </div>
              <Panel>
                {defs.map((def) => (
                  <SignalRow
                    key={def.id}
                    def={def}
                    pol={policy.signals[def.id]}
                    onChange={(patch) => update(def.id, patch)}
                  />
                ))}
              </Panel>
            </div>
          );
        })}
    </section>
  );
}
