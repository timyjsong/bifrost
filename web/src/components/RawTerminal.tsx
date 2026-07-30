import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getCapture } from "../lib/drive";
import { startGuardedPoll } from "../lib/poll";

/**
 * The raw-terminal fallback (M6) — a live xterm.js mirror of the session's pane,
 * the always-works escape hatch when the semantic layer can't cover something
 * (e.g. a permission menu the parser missed). Read-only: it polls capture-pane
 * (with colour escapes) and redraws the current frame. Latency is tolerated here
 * — this is the fallback, not the no-lag path. The prompt box (M3) remains the
 * actionable manual input alongside it.
 */
export function RawTerminal({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: true,
      fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
      fontSize: 12,
      disableStdin: true,
      cursorBlink: false,
      scrollback: 0,
      theme: { background: "#0a0a0a", foreground: "#e5e5e5" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    const refit = () => {
      try {
        fit.fit();
      } catch {
        /* host not measured yet */
      }
    };
    refit();
    window.addEventListener("resize", refit);

    let alive = true;
    // Guarded poll (was setInterval): a slow capture never lets the next redraw
    // fire before this one lands.
    const stopPoll = startGuardedPoll(async () => {
      const text = await getCapture(sessionId);
      if (!alive || text === null) return;
      term.write("\x1b[H\x1b[2J" + text); // home + clear + redraw the live frame
    }, 800);

    return () => {
      alive = false;
      stopPoll();
      window.removeEventListener("resize", refit);
      term.dispose();
    };
  }, [sessionId]);

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />;
}
