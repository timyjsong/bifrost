import { useEffect, useState } from "react";
import { SPAWN_MODELS, type SpawnModelAlias } from "../../../shared/types";
import { fetchSettings, saveSettings } from "../lib/settings";
import { Panel, SectionTitle } from "./ui";

// Grace-period choices. "Off" sends immediately (no undo window).
const GRACE_OPTIONS: Array<{ ms: number; label: string }> = [
  { ms: 0, label: "Off" },
  { ms: 1000, label: "1s" },
  { ms: 2000, label: "2s" },
  { ms: 3000, label: "3s" },
  { ms: 5000, label: "5s" },
  { ms: 10000, label: "10s" },
];

export function SettingsPane() {
  const [sendDelayMs, setSendDelayMs] = useState<number | null>(null);
  const [defaultModel, setDefaultModel] = useState<SpawnModelAlias | null>(null);

  useEffect(() => {
    void fetchSettings().then((s) => {
      setSendDelayMs(s.sendDelayMs);
      setDefaultModel(s.defaultModel);
    });
  }, []);

  const update = (ms: number) => {
    setSendDelayMs(ms); // optimistic; server is the source of truth
    void saveSettings({ sendDelayMs: ms });
  };

  const updateModel = (m: SpawnModelAlias) => {
    setDefaultModel(m); // optimistic; server is the source of truth
    void saveSettings({ defaultModel: m });
  };

  return (
    <section id="settings" className="scroll-mt-[72px]">
      <SectionTitle title="Settings" hint="prompting behavior" />
      <Panel className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-[13px] text-ink">Send grace period</span>
            <span className="text-[12px] text-ink-mute">
              after you send, hold this long before it actually goes — stop
              (alt+enter) within the window to undo. Closing the app still sends.
            </span>
          </div>
          <select
            value={sendDelayMs ?? 3000}
            disabled={sendDelayMs === null}
            onChange={(e) => update(Number(e.target.value))}
            className="shrink-0 rounded-md border border-line-soft bg-panel px-2 py-1 font-mono text-[12px] text-ink-dim disabled:opacity-50"
          >
            {GRACE_OPTIONS.map((o) => (
              <option key={o.ms} value={o.ms}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-3 flex items-center gap-3 border-t border-line-soft pt-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-[13px] text-ink">Default model</span>
            <span className="text-[12px] text-ink-mute">
              preselected when starting a new session — Bifrost&rsquo;s own
              default, separate from your Claude account default.
            </span>
          </div>
          <select
            value={defaultModel ?? "opus"}
            disabled={defaultModel === null}
            onChange={(e) => updateModel(e.target.value as SpawnModelAlias)}
            className="shrink-0 rounded-md border border-line-soft bg-panel px-2 py-1 font-mono text-[12px] text-ink-dim disabled:opacity-50"
          >
            {SPAWN_MODELS.map((m) => (
              <option key={m.alias} value={m.alias}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      </Panel>
    </section>
  );
}
