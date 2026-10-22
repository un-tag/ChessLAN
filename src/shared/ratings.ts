// Ratings and head-to-head stats, always derived from the game log.
import type { GameRecord } from "./protocol";
import { RATED_CATEGORIES, type RatedCategory } from "./timeControl";

export const START_RATING = 400;
export const K_FACTOR = 32;
export const RATING_FLOOR = 100;

export interface CategoryRating {
  rating: number;
  games: number;
  peak: number;
  history: { at: number; rating: number }[];
}

export type PlayerRatings = Record<RatedCategory, CategoryRating>;

export interface RatingState {
  players: Map<string, PlayerRatings>;
  /** Ratings before/after each rated game, by game id. */
  changes: Map<string, { category: RatedCategory; w: { before: number; after: number }; b: { before: number; after: number } }>;
}

export const isRated = (r: GameRecord): boolean =>
  r.rated && !r.bot && r.category !== "untimed" && r.white.id !== r.black.id;

const freshRatings = (): PlayerRatings =>
  Object.fromEntries(
    RATED_CATEGORIES.map((c) => [c, { rating: START_RATING, games: 0, peak: START_RATING, history: [] }]),
  ) as unknown as PlayerRatings;

export function expectedScore(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

export function eloUpdate(a: number, b: number, scoreA: number): [number, number] {
  const ea = expectedScore(a, b);
  const na = Math.max(RATING_FLOOR, Math.round(a + K_FACTOR * (scoreA - ea)));
  const nb = Math.max(RATING_FLOOR, Math.round(b + K_FACTOR * (1 - scoreA - (1 - ea))));
  return [na, nb];
}

export function computeRatings(records: readonly GameRecord[]): RatingState {
  const players = new Map<string, PlayerRatings>();
  const changes: RatingState["changes"] = new Map();
  const get = (id: string): PlayerRatings => {
    let p = players.get(id);
    if (!p) players.set(id, (p = freshRatings()));
    return p;
  };
  // Same order on every peer, whatever order their logs are in.
  const sorted = [...records].sort((a, b) => a.endedAt - b.endedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of sorted) {
    if (!isRated(r)) continue;
    const cat = r.category as RatedCategory;
    const w = get(r.white.id)[cat];
    const b = get(r.black.id)[cat];
    const score = r.result === "1-0" ? 1 : r.result === "0-1" ? 0 : 0.5;
    const [nw, nb] = eloUpdate(w.rating, b.rating, score);
    changes.set(r.id, { category: cat, w: { before: w.rating, after: nw }, b: { before: b.rating, after: nb } });
    for (const [entry, value] of [[w, nw], [b, nb]] as const) {
      entry.rating = value;
      entry.games++;
      entry.peak = Math.max(entry.peak, value);
      entry.history.push({ at: r.endedAt, rating: value });
    }
  }
  return { players, changes };
}

export function ratingsFor(state: RatingState, playerId: string): PlayerRatings {
  return state.players.get(playerId) ?? freshRatings();
}

export interface HeadToHead {
  wins: number;
  losses: number;
  draws: number;
  /** Current streak from `me`'s point of view: positive = wins in a row, negative = losses. */
  streak: number;
  bestWinStreak: number;
}

/** Head-to-head between two humans (bot games excluded), optionally filtered by category. */
export function headToHead(
  records: readonly GameRecord[],
  me: string,
  them: string,
  category?: RatedCategory | "untimed",
): HeadToHead {
  const out: HeadToHead = { wins: 0, losses: 0, draws: 0, streak: 0, bestWinStreak: 0 };
  let run = 0;
  const sorted = [...records].sort((a, b) => a.endedAt - b.endedAt);
  for (const r of sorted) {
    if (r.bot) continue;
    const ids = [r.white.id, r.black.id];
    if (!ids.includes(me) || !ids.includes(them) || me === them) continue;
    if (category && r.category !== category) continue;
    const myWin = (r.result === "1-0" && r.white.id === me) || (r.result === "0-1" && r.black.id === me);
    if (r.result === "1/2-1/2") {
      out.draws++;
      out.streak = 0;
      run = 0;
    } else if (myWin) {
      out.wins++;
      out.streak = out.streak > 0 ? out.streak + 1 : 1;
      run++;
      out.bestWinStreak = Math.max(out.bestWinStreak, run);
    } else {
      out.losses++;
      out.streak = out.streak < 0 ? out.streak - 1 : -1;
      run = 0;
    }
  }
  return out;
}
