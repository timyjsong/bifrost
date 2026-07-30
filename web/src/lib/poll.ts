/**
 * Guarded polling — the fix for fixed-interval polls that fire regardless of
 * whether the prior request resolved (pile-up on a slow mobile link). Instead
 * of setInterval, this schedules the NEXT tick only AFTER the current one
 * settles, so at most one request is ever in flight per poller. The effective
 * gap is (request duration + intervalMs), which self-throttles under latency.
 * A thrown tick is swallowed (a transient failure must not kill the loop) and
 * the next tick is still scheduled.
 */
export function startGuardedPoll(
  tick: () => Promise<void>,
  intervalMs: number,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch {
      /* transient — keep polling */
    }
    if (stopped) return;
    timer = setTimeout(run, intervalMs);
  };
  void run();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
