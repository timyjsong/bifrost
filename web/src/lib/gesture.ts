/**
 * iOS-style edge-swipe-to-go-back math. Pure, so the thresholds are a tested
 * contract; DriveView wires the touch events and applies the transform.
 *
 * The gesture: a rightward horizontal drag from ANYWHERE on the view slides the
 * chat overlay across, revealing the page beneath; released past a fraction of
 * the width it completes (navigates back), else it snaps closed. The horizontal-
 * vs-vertical commit check is what keeps vertical scrolling intact — the
 * transcript itself can't scroll horizontally, so a rightward drag is unambiguous.
 */
export const COMMIT_PX = 8; // movement before we decide horizontal-vs-vertical
export const COMPLETE_FRACTION = 0.35; // released past this fraction of width → go back

/** Once moving past the commit threshold, it's a back-drag only if it's rightward
 *  and more horizontal than vertical (so vertical scrolling still wins). */
export function isHorizontalBack(dx: number, dy: number): boolean {
  return dx > 0 && Math.abs(dx) > Math.abs(dy);
}

/** True once the finger has moved far enough to decide the gesture's direction. */
export function isCommitted(dx: number, dy: number): boolean {
  return Math.abs(dx) >= COMMIT_PX || Math.abs(dy) >= COMMIT_PX;
}

/** How far the panel has moved — clamped to [0, width], never negative (can't
 *  drag past closed or off the left edge). */
export function clampDrag(dx: number, width: number): number {
  return Math.max(0, Math.min(dx, width));
}

/** On release: complete the back navigation if dragged past the threshold. */
export function shouldComplete(dx: number, width: number): boolean {
  return width > 0 && dx >= width * COMPLETE_FRACTION;
}

/**
 * Auto-scroll should stick to the bottom on new content ONLY when the reader is
 * already near the bottom — otherwise it steals scroll position from someone
 * reading scrollback mid-turn (the big-transcript jank). Pure so the threshold
 * is a tested contract.
 */
export const STICK_THRESHOLD_PX = 120;

export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = STICK_THRESHOLD_PX,
): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}
