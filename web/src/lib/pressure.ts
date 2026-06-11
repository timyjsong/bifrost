/**
 * Green→red gradient where the color tracks the percentage intuitively:
 * 0% green, ~50% orange, 100% red. Raw hue interpolation reads too green in
 * the middle (hue 70 still looks green), so anchor stops pin the midpoint
 * to true orange and lerp between them.
 */
const STOPS: [number, number][] = [
  [0, 140], // green
  [0.25, 95], // yellow-green
  [0.5, 38], // orange
  [0.75, 16], // red-orange
  [1, 0], // red
];

export function pressureHue(ratio: number): number {
  const r = Math.max(0, Math.min(1, ratio));
  for (let i = 1; i < STOPS.length; i++) {
    const [r1, h1] = STOPS[i - 1];
    const [r2, h2] = STOPS[i];
    if (r <= r2) return h1 + ((r - r1) / (r2 - r1)) * (h2 - h1);
  }
  return 0;
}

export function pressureColor(ratio: number): string {
  return `hsl(${pressureHue(ratio)} 52% 53%)`;
}
