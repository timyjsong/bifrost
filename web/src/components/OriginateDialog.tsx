import { useEffect, useRef, useState } from "react";
import type { DirPick } from "../../../shared/types";
import type { ProjectInfo } from "../../../shared/types";
import {
  ORIGINATE_MODELS,
  originate,
  validateOriginate,
  type ModelAlias,
} from "../lib/originate";
import { fetchDirs } from "../lib/files";
import { fetchSettings } from "../lib/settings";
import { Panel } from "./ui";

/**
 * The originate picker (story 2-5 / AC5.1) — presentation only; validation is the
 * pure validateOriginate + the server's re-check. Two modes:
 *  - browser mode (no `projects`): cwd is the folder the file browser is showing;
 *    pick a subdir by navigating the browser first.
 *  - picker mode (`projects` given): a top-level "new session" — browse the
 *    server's real directory tree (home-rooted, descend/ascend) to the exact
 *    folder to start in.
 * Model is the allowlist, preselected from the Bifrost default-model setting;
 * name is optional. On success it reports back so the parent can route into the
 * new session's drive view.
 */
export function OriginateDialog({
  cwd: fixedCwd,
  projectName,
  projects,
  onClose,
  onStarted,
}: {
  cwd: string;
  projectName: string;
  projects?: ProjectInfo[];
  onClose: () => void;
  onStarted: (sessionId: string) => void;
}) {
  const [model, setModel] = useState<ModelAlias>(ORIGINATE_MODELS[0].alias);
  const modelTouched = useRef(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [caution, setCaution] = useState<string | null>(null);
  // Picker mode: the browsed server directory IS the cwd.
  const picker = projects !== undefined;
  const [browse, setBrowse] = useState<DirPick | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);

  useEffect(() => {
    if (!picker) return;
    fetchDirs()
      .then(setBrowse)
      .catch(() => setBrowseError("couldn't list the server directory"));
  }, [picker]);

  // Preselect the configured default model — until the user picks one here.
  useEffect(() => {
    void fetchSettings().then((s) => {
      if (!modelTouched.current) setModel(s.defaultModel);
    });
  }, []);

  const nav = (path: string) => {
    setBrowseError(null);
    fetchDirs(path)
      .then(setBrowse)
      .catch(() => setBrowseError("couldn't open that folder"));
  };

  const cwd = picker ? (browse?.path ?? "") : fixedCwd;
  const form = { cwd, model, name };
  const v = validateOriginate(form);

  async function start() {
    if (!v.ok || busy) return;
    setBusy(true);
    setError(null);
    setCaution(null);
    try {
      const res = await originate(form);
      if (res.ok === true) {
        if (res.caution) setCaution(res.caution);
        onStarted(res.sessionId);
      } else {
        // The server's structured failure: memory-blocked carries a message;
        // a bad field / spawn failure carries a reason/detail.
        setError(res.message ?? res.detail ?? res.reason);
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`${picker ? "fixed z-50" : "absolute z-10"} inset-0 flex items-center justify-center bg-black/50 p-4`}
    >
      <Panel className="w-full max-w-md p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[13px] font-medium text-ink">Start a session</h3>
          <button
            onClick={onClose}
            className="rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-mute hover:text-ink-dim"
          >
            cancel
          </button>
        </div>

        {picker ? (
          <>
            <label className="mb-1 block text-[11px] uppercase tracking-[0.14em] text-ink-mute">
              folder
            </label>
            <div
              className="mb-1 truncate rounded-md border border-line bg-panel-raised/40 px-2.5 py-1.5 font-mono text-[12px] text-ink"
              title={cwd}
            >
              {browse ? browse.path : "loading…"}
            </div>
            <div className="mb-2 max-h-44 overflow-y-auto rounded-md border border-line-soft">
              {browse?.parent != null && (
                <button
                  onClick={() => nav(browse.parent!)}
                  className="block w-full px-2.5 py-1 text-left font-mono text-[12px] text-ink-mute transition-colors hover:bg-panel-raised hover:text-ink"
                >
                  ← ..
                </button>
              )}
              {browse?.dirs.map((d) => (
                <button
                  key={d}
                  onClick={() => nav(`${browse.path}/${d}`)}
                  className="block w-full truncate px-2.5 py-1 text-left font-mono text-[12px] text-ink-dim transition-colors hover:bg-panel-raised hover:text-ink"
                >
                  {d}/
                </button>
              ))}
              {browse && browse.dirs.length === 0 && (
                <div className="px-2.5 py-1 text-[11px] text-ink-mute">no subfolders</div>
              )}
            </div>
            {browseError && <p className="mb-2 text-[12px] text-danger">{browseError}</p>}
          </>
        ) : (
          <>
            <label className="mb-1 block text-[11px] uppercase tracking-[0.14em] text-ink-mute">
              folder
            </label>
            <div
              className="mb-3 truncate rounded-md border border-line bg-panel-raised/40 px-2.5 py-1.5 font-mono text-[12px] text-ink-dim"
              title={cwd}
            >
              {cwd}
            </div>
            <p className="-mt-2 mb-3 text-[11px] text-ink-mute">
              Browse into a subfolder of {projectName} to start there.
            </p>
          </>
        )}

        <label className="mb-1 block text-[11px] uppercase tracking-[0.14em] text-ink-mute">
          model
        </label>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {ORIGINATE_MODELS.map((m) => (
            <button
              key={m.alias}
              onClick={() => {
                modelTouched.current = true;
                setModel(m.alias);
              }}
              className={`rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
                model === m.alias
                  ? "border-gold-dim/60 text-gold"
                  : "border-line text-ink-mute hover:text-ink-dim"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <label className="mb-1 block text-[11px] uppercase tracking-[0.14em] text-ink-mute">
          name <span className="text-ink-mute/60">(optional)</span>
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. nightly build"
          className="mb-3 w-full rounded-md border border-line bg-panel-raised/40 px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-gold-dim/60"
        />

        {v.ok === false && (
          <p className="mb-2 text-[12px] text-ink-mute">{v.message}</p>
        )}
        {caution && <p className="mb-2 text-[12px] text-gold">{caution}</p>}
        {error && <p className="mb-2 text-[12px] text-danger">{error}</p>}

        <button
          onClick={start}
          disabled={!v.ok || busy}
          className={`w-full rounded-md border px-3 py-2 text-[13px] transition-colors ${
            v.ok && !busy
              ? "border-gold-dim/60 text-gold hover:bg-gold-dim/10"
              : "border-line text-ink-mute"
          }`}
        >
          {busy ? "starting…" : "start session"}
        </button>
      </Panel>
    </div>
  );
}
