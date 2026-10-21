export interface TimeControl {
  initialMs: number;
  incrementMs: number;
}

export type RatedCategory = "bullet" | "blitz" | "rapid";
export type Category = RatedCategory | "untimed";
export const RATED_CATEGORIES: RatedCategory[] = ["bullet", "blitz", "rapid"];

const min = (m: number, incSec = 0): TimeControl => ({ initialMs: m * 60_000, incrementMs: incSec * 1000 });

export const ONE_MIN = min(1);
export const TEN_MIN = min(10);

// chess.com's "More time controls" list.
export const PRESETS: { group: "Bullet" | "Blitz" | "Rapid"; tc: TimeControl }[] = [
  { group: "Bullet", tc: min(1) },
  { group: "Bullet", tc: min(1, 1) },
  { group: "Bullet", tc: min(2, 1) },
  { group: "Bullet", tc: min(0.5) },
  { group: "Bullet", tc: { initialMs: 20_000, incrementMs: 1000 } },
  { group: "Blitz", tc: min(3) },
  { group: "Blitz", tc: min(3, 2) },
  { group: "Blitz", tc: min(5) },
  { group: "Blitz", tc: min(5, 5) },
  { group: "Blitz", tc: min(5, 2) },
  { group: "Rapid", tc: min(10) },
  { group: "Rapid", tc: min(15, 10) },
  { group: "Rapid", tc: min(30) },
  { group: "Rapid", tc: min(10, 5) },
  { group: "Rapid", tc: min(20) },
  { group: "Rapid", tc: min(60) },
];

/** chess.com categories: estimated duration = base + 40 × increment. */
export function categoryOf(tc: TimeControl | null): Category {
  if (!tc) return "untimed";
  const estimate = tc.initialMs + 40 * tc.incrementMs;
  if (estimate < 180_000) return "bullet";
  if (estimate < 600_000) return "blitz";
  return "rapid";
}

function formatBase(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} sec`;
  const m = ms / 60_000;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
}

/** "1 min", "30 sec", "3 | 2", "Untimed". */
export function formatTimeControl(tc: TimeControl | null): string {
  if (!tc) return "Untimed";
  if (!tc.incrementMs) return formatBase(tc.initialMs);
  const base = tc.initialMs < 60_000 ? `${tc.initialMs / 1000}s` : `${tc.initialMs / 60_000}`;
  return `${base} | ${tc.incrementMs / 1000}`;
}

/** PGN TimeControl tag, e.g. "60+0". */
export function pgnTimeControl(tc: TimeControl | null): string {
  return tc ? `${Math.round(tc.initialMs / 1000)}+${Math.round(tc.incrementMs / 1000)}` : "-";
}

export function animationMsFor(tc: TimeControl | null): number {
  const c = categoryOf(tc);
  return c === "bullet" ? 80 : c === "blitz" ? 120 : 150;
}

export const categoryLabel = (c: Category): string => c[0].toUpperCase() + c.slice(1);
