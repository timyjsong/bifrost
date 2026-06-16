import { useEffect, useState } from "react";
import { setToken } from "../lib/api";

/** A `#code=…` fragment from the box's enroll QR/link, if present. */
function codeFromHash(): string {
  const m = location.hash.match(/code=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

/**
 * The gate the whole app sits behind until a device token exists. A code from the
 * QR's URL fragment auto-submits (scan → enrolled); otherwise paste the code the
 * box printed. On success the token is persisted and the dashboard mounts.
 */
export function Enroll({ onEnrolled }: { onEnrolled: () => void }) {
  const [code, setCode] = useState(codeFromHash);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (value: string) => {
    const c = value.trim();
    if (!c || busy) return;
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: c, label: navigator.platform || "device" }),
      });
      if (!res.ok) {
        setErr("That code is invalid or expired — generate a fresh one on the box.");
        return;
      }
      const { token } = (await res.json()) as { token: string };
      setToken(token);
      if (location.hash) history.replaceState(null, "", location.pathname);
      onEnrolled();
    } catch {
      setErr("Couldn’t reach Bifrost.");
    } finally {
      setBusy(false);
    }
  };

  // QR path: a code already in the URL fragment → enroll automatically.
  useEffect(() => {
    if (code) void submit(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6">
      <div className="flex flex-col items-center gap-3">
        <div className="text-[15px] font-semibold tracking-[0.32em] text-ink">BIFROST</div>
        <div className="h-px w-7 bg-gold/70" />
        <div className="text-[12px] text-ink-mute">enroll this device</div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(code);
        }}
        className="flex w-full max-w-xs flex-col gap-3"
      >
        <input
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="enrollment code"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className="rounded-md border border-line-soft bg-panel-raised px-3 py-2 text-center font-mono text-[13px] text-ink outline-none focus:border-gold-dim"
        />
        <button
          type="submit"
          disabled={busy || !code.trim()}
          className="rounded-md border border-gold-dim/70 bg-gold/10 px-3 py-2 text-[13px] font-medium text-gold transition-colors hover:bg-gold/20 disabled:opacity-40"
        >
          {busy ? "enrolling…" : "enroll"}
        </button>
        {err && <div className="text-center text-[11.5px] text-danger">{err}</div>}
      </form>
      <div className="max-w-xs text-center text-[11px] leading-relaxed text-ink-mute/70">
        Run <span className="font-mono text-ink-mute">bun run enroll</span> on the box, then
        scan the QR or paste the code above.
      </div>
    </div>
  );
}
