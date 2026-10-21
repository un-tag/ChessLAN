// Bot strength levels, personalities and the single chooseMove() entry point.
// Weakness is human-shaped: shallow search, noisy (softmax) move choice,
// occasional oversights (a one-ply look that ignores the reply, or a much
// shallower search), random moves and missed mates at the bottom. Styles are
// eval weights plus root move biases.
import {
  F_CAPTURE,
  F_CASTLE,
  KNIGHT,
  PAWN,
  Position,
  QUEEN,
  moveFlags,
  moveFrom,
  movePromo,
  moveTo,
  moveToUci,
  parseSquare,
} from "../chess/position";
import { Engine, MATE, MATE_BOUND, matePlies } from "./engine";
import { Evaluator, type EvalStyle } from "./eval";

/** How strong a bot plays and how human its mistakes look. */
export interface Level {
  /** 1..10 (0 for the random mover). */
  level: number;
  /** Rough Elo against humans. */
  elo: number;
  /** Maximum search depth in plies. */
  depth: number;
  /** Engine time budget per move (ms). */
  thinkMs: number;
  /** Engine node budget per move; keeps strength similar across machines. */
  nodes: number;
  /** Softmax temperature over root move scores (cp); 0 always plays the best. */
  temperature: number;
  /** Chance per move of a uniformly random legal move. */
  randomMove: number;
  /** Chance per move of an oversight: judging moves at `oversightDepth` instead. */
  oversight: number;
  /**
   * 0: a one-ply look that ignores every reply (hangs pieces, grabs poisoned
   * ones). 1+: a shallow search that sees recaptures but misses deeper tactics.
   */
  oversightDepth: number;
  /** Chance per move of not noticing a mate. */
  missMate: number;
  /**
   * Human-ish pause [min, max] ms. The caller picks a value in this range and
   * shows the move no earlier than that long after asking (the engine's own
   * thinking time counts towards it). The engine itself never sleeps.
   */
  delayMs: [number, number];
}

/** Eval weights (see EvalStyle) plus biases (cp) added to root move scores. */
export interface BotStyle extends EvalStyle {
  checkBias?: number;
  captureBias?: number;
  pawnBias?: number;
  /** Queen moves during the first 20 moves. */
  queenBias?: number;
  knightBias?: number;
  castleBias?: number;
}

export interface BotConfig {
  id: string;
  name: string;
  /** One fun line for the UI. */
  description: string;
  /** Rating estimate shown in the UI. */
  rating: number;
  avatar: string;
  kind: "level" | "personality";
  level: Level;
  style: BotStyle;
}

export interface ChooseOptions {
  /** Overrides the level's engine time budget (ms). */
  timeMs?: number;
  /** Overrides the level's node budget. */
  maxNodes?: number;
  /** Source of randomness in [0, 1); pass a seeded one for reproducible play. */
  random?: () => number;
}

export interface BotMove {
  /** UCI move, or "" when the side to move has no legal move. */
  uci: string;
  /** Bot's evaluation of the chosen move (cp, its own point of view), null if it didn't search. */
  scoreCp: number | null;
  /** Moves to mate (positive: the bot mates), when scoreCp is a mate score. */
  mate: number | null;
  depth: number;
  nodes: number;
}

const lvl = (
  level: number,
  elo: number,
  depth: number,
  thinkMs: number,
  nodes: number,
  temperature: number,
  randomMove: number,
  oversight: number,
  oversightDepth: number,
  missMate: number,
  delayMs: [number, number],
): Level => ({ level, elo, depth, thinkMs, nodes, temperature, randomMove, oversight, oversightDepth, missMate, delayMs });

// prettier-ignore
export const LEVELS: readonly Level[] = [
  //   lvl   elo depth thinkMs   nodes  temp  random oversight (depth) missMate  delay
  lvl(1,   250,  1,   300,    20_000, 220,  0.22,  0.30,     0,      0.5,  [700, 2400]),
  lvl(2,   400,  1,   400,    20_000, 150,  0.10,  0.28,     0,      0.3,  [700, 2400]),
  lvl(3,   550,  2,   500,    30_000, 110,  0.05,  0.22,     0,      0.12, [700, 2200]),
  lvl(4,   700,  2,   600,    30_000,  80,  0.02,  0.16,     0,      0.05, [650, 2200]),
  lvl(5,   850,  2,   800,    60_000,  55,  0,     0.12,     1,      0,    [600, 2000]),
  lvl(6,  1000,  3,  1000,   100_000,  40,  0,     0.08,     1,      0,    [600, 2000]),
  lvl(7,  1200,  4,  1200,   200_000,  25,  0,     0.05,     2,      0,    [500, 1800]),
  lvl(8,  1400,  5,  1500,   400_000,  14,  0,     0.03,     2,      0,    [500, 1600]),
  lvl(9,  1700,  7,  2000, 1_000_000,   6,  0,     0,        0,      0,    [400, 1400]),
  lvl(10, 2000, 64,  2500, 2_500_000,   0,  0,     0,        0,      0,    [300, 1200]),
];

const LEVEL_TEXT: [string, string][] = [
  ["🐣", "Just found out how the horsey moves."],
  ["🐤", "Knows the rules, mostly. Leaves pieces lying around."],
  ["🐥", "Spots a free piece now and then. Now and then."],
  ["🐦", "Starting to look one move ahead. Sometimes."],
  ["🦉", "Sees simple tactics and punishes loose pieces."],
  ["🦊", "Sneaky. Rarely hangs anything for free."],
  ["🐺", "Solid club player. Forks and pins are on the menu."],
  ["🦁", "Calculates well and converts its advantages."],
  ["🐉", "Strong and tricky. Bring your best game."],
  ["🤖", "Full power. Good luck."],
];

export const LEVEL_BOTS: readonly BotConfig[] = LEVELS.map((level, i) => ({
  id: `level-${level.level}`,
  name: `Level ${level.level}`,
  description: LEVEL_TEXT[i][1],
  rating: level.elo,
  avatar: LEVEL_TEXT[i][0],
  kind: "level",
  level,
  style: {},
}));

export const PERSONALITIES: readonly BotConfig[] = [
  {
    id: "random-randy",
    name: "Random Randy",
    description: "Moves whatever the dice say. Pure chaos, zero plans.",
    rating: 100,
    avatar: "🎲",
    kind: "personality",
    level: { ...LEVELS[0], level: 0, elo: 100, randomMove: 1, delayMs: [400, 1200] },
    style: {},
  },
  {
    id: "pawnstorm-pete",
    name: "Pawnstorm Pete",
    description: "Never met a pawn he didn't want to push. Charge!",
    rating: 600,
    avatar: "🌪️",
    kind: "personality",
    level: LEVELS[2],
    style: { pawnAdvance: 12, pawnBias: 80, kingShield: 0.4 },
  },
  {
    id: "turtle-tom",
    name: "Turtle Tom",
    description: "Castles early, trades everything and hides in his shell.",
    rating: 650,
    avatar: "🐢",
    kind: "personality",
    level: LEVELS[3],
    style: { kingShield: 2.5, trades: 8, castleBias: 120, captureBias: 20, attack: 0, pawnAdvance: -4 },
  },
  {
    id: "queenie",
    name: "Queenie",
    description: "Her queen is out by move two and she's not sorry.",
    rating: 800,
    avatar: "👑",
    kind: "personality",
    level: LEVELS[4],
    style: { queenSortie: 60, queenBias: 90, attack: 1.5 },
  },
  {
    id: "aggro-annie",
    name: "Aggro Annie",
    description: "All-out attack. Sacrifices first, asks questions later.",
    rating: 950,
    avatar: "🔥",
    kind: "personality",
    level: LEVELS[5],
    style: { attack: 8, material: 0.8, checkBias: 70, captureBias: 25, kingShield: 0.6, mobility: 1.3, pawnAdvance: 3 },
  },
  {
    id: "knightmare-nick",
    name: "Knightmare Nick",
    description: "Loves knights and forks. Hop, hop, check!",
    rating: 1150,
    avatar: "🐴",
    kind: "personality",
    level: LEVELS[6],
    style: { knightLove: 30, knightBias: 40, checkBias: 20 },
  },
];

export const ALL_BOTS: readonly BotConfig[] = [...LEVEL_BOTS, ...PERSONALITIES];

export const getBot = (id: string): BotConfig | undefined => ALL_BOTS.find((b) => b.id === id);

/** Small seeded PRNG (mulberry32) for reproducible bot games and tests. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONTEMPT = 15;

let engine: Engine | null = null;

/** Finds a legal move by UCI ("e7e8" promotes to a queen); 0 if illegal. */
function parseUci(pos: Position, uci: string): number {
  const from = parseSquare(uci.slice(0, 2));
  const to = parseSquare(uci.slice(2, 4));
  const promo = uci.length > 4 ? " pnbrqk".indexOf(uci[4].toLowerCase()) : 0;
  for (const m of pos.generateLegal()) {
    if (moveFrom(m) !== from || moveTo(m) !== to) continue;
    if (movePromo(m) && movePromo(m) !== (promo > 0 ? promo : QUEEN)) continue;
    return m;
  }
  return 0;
}

/** Replays `history` (UCI) from `fen`, keeping hashes for repetition checks. */
export function positionFrom(fen: string, history: readonly string[]): Position {
  let pos = Position.fromFen(fen);
  for (const uci of history) {
    const m = parseUci(pos, uci);
    if (!m) throw new Error(`Illegal move in history: ${uci}`);
    pos.makeMove(m);
    // Keep the undo stack short: nothing before an irreversible move can repeat.
    if (pos.halfmove === 0 && pos.ply > 200) pos = Position.fromFen(pos.fen());
  }
  return pos;
}

function moveBias(pos: Position, m: number, style: BotStyle): number {
  const flags = moveFlags(m);
  const type = pos.board[moveFrom(m)] & 7;
  let bias = 0;
  if (flags & F_CAPTURE) bias += style.captureBias ?? 0;
  if (flags & F_CASTLE) bias += style.castleBias ?? 0;
  if (type === PAWN) bias += style.pawnBias ?? 0;
  if (type === KNIGHT) bias += style.knightBias ?? 0;
  if (type === QUEEN && pos.fullmove <= 20) bias += style.queenBias ?? 0;
  if (style.checkBias) {
    pos.makeMove(m);
    if (pos.inCheck()) bias += style.checkBias;
    pos.unmakeMove();
  }
  return bias;
}

// Upper bound on the bias one move can collect.
const maxBias = (s: BotStyle): number =>
  (s.checkBias ?? 0) + (s.captureBias ?? 0) + (s.pawnBias ?? 0) + (s.queenBias ?? 0) + (s.knightBias ?? 0) + (s.castleBias ?? 0);

const isNatural = (m: number): boolean => !movePromo(m) || movePromo(m) === QUEEN;

/** Index drawn with probability proportional to exp(score / temperature). */
function softmax(scores: number[], temperature: number, random: () => number): number {
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  if (temperature <= 0) return best;
  const w = scores.map((s) => Math.exp((s - scores[best]) / temperature));
  let r = random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < w.length; i++) {
    r -= w[i];
    if (r < 0) return i;
  }
  return best;
}

/** One-ply judgement: how the position looks right after the move, ignoring replies. */
function oversightMove(pos: Position, legal: number[], ev: Evaluator, bot: BotConfig, blind: boolean, random: () => number): number {
  const scores = legal.map((m) => {
    const bias = moveBias(pos, m, bot.style);
    pos.makeMove(m);
    let s = -ev.evaluate(pos);
    if (!pos.hasLegalMove()) s = !pos.inCheck() ? 0 : blind ? s : MATE - 1;
    pos.unmakeMove();
    return s + bias;
  });
  return legal[softmax(scores, Math.max(bot.level.temperature, 30), random)];
}

/**
 * Picks the bot's move for the position reached by playing `history` (UCI)
 * from `fen`. Always returns a legal move when one exists. Reproducible with
 * a seeded `random` as long as the node budget, not the clock, ends the search.
 */
export function chooseMove(fen: string, history: readonly string[], bot: BotConfig, opts: ChooseOptions = {}): BotMove {
  const pos = positionFrom(fen, history);
  const random = opts.random ?? Math.random;
  const level = bot.level;
  const legal = pos.generateLegal();
  const done = (m: number, scoreCp: number | null = null, depth = 0, nodes = 0): BotMove => {
    const plies = scoreCp === null ? null : matePlies(scoreCp);
    const mate = plies === null ? null : plies > 0 ? Math.ceil(plies / 2) : -Math.ceil(-plies / 2);
    return { uci: m ? moveToUci(m) : "", scoreCp, mate, depth, nodes };
  };
  if (!legal.length) return done(0);
  if (legal.length === 1) return done(legal[0]);
  // Humans don't underpromote by accident: noisy picks only promote to a queen.
  const natural = legal.filter(isNatural);
  if (level.randomMove > 0 && random() < level.randomMove) return done(natural[Math.floor(random() * natural.length)]);

  const ev = new Evaluator(bot.style, pos.turn);
  const blind = level.missMate > 0 && random() < level.missMate;
  const oversight = level.oversight > 0 && random() < level.oversight;
  if (oversight && level.oversightDepth === 0) {
    return done(oversightMove(pos, natural, ev, bot, blind, random), null, 1, natural.length);
  }

  const bias = maxBias(bot.style);
  const scored = level.temperature > 0 || bias > 0 || blind;
  const margin = scored ? Math.max(5 * level.temperature, bias) + 50 : 0;
  engine ??= new Engine();
  const res = engine.search(pos, ev, {
    maxDepth: oversight ? level.oversightDepth : level.depth,
    timeMs: opts.timeMs ?? level.thinkMs,
    maxNodes: opts.maxNodes ?? level.nodes,
    rootMargin: margin,
    contempt: CONTEMPT,
  });
  if (!scored) return done(res.move, res.score, res.depth, res.nodes);

  const root = res.root.filter((r, i) => i === 0 || isNatural(r.move));
  const scores = root.map((r) => {
    let s = r.score;
    if (blind && s > MATE_BOUND) {
      // Doesn't see the mate: judges the move by how the position looks.
      pos.makeMove(r.move);
      s = -ev.evaluate(pos);
      pos.unmakeMove();
    }
    return s + moveBias(pos, r.move, bot.style);
  });
  // Clearly winning: play more carefully so won games actually get won.
  const lead = Math.min(Math.max(res.root[0].score - 400, 0), 1200);
  const pick = softmax(scores, level.temperature / (1 + lead / 400), random);
  return done(root[pick].move, root[pick].score, res.depth, res.nodes);
}
