/**
 * Tail-windowing for the drive transcript: a multi-MB session holds thousands
 * of messages, and rendering every one mounts (and re-mounts, on each redial)
 * the whole DOM — the mobile cliff. Chat attention lives at the tail, so render
 * the last `limit` messages by default and reveal the rest on demand. Pure so
 * the boundary math is tested, not eyeballed.
 */
export interface MessageWindow<T> {
  visible: T[];
  hiddenCount: number; // messages held in state but not rendered (0 when all shown)
}

export function windowMessages<T>(
  messages: T[],
  limit: number,
  expanded: boolean,
): MessageWindow<T> {
  if (expanded || messages.length <= limit) {
    return { visible: messages, hiddenCount: 0 };
  }
  const hiddenCount = messages.length - limit;
  return { visible: messages.slice(hiddenCount), hiddenCount };
}
