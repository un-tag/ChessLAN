// Web Worker (module) running the bot off the UI thread. Create it with
// new Worker(new URL("../shared/bot/bot.worker.ts", import.meta.url), { type: "module" }).
import { chooseMove, getBot } from "./bots";

export interface BotRequest {
  id: number;
  fen: string;
  /** UCI moves played from `fen`, for repetition detection. */
  history: string[];
  botId: string;
  timeMs?: number;
}

export interface BotResponse {
  id: number;
  /** "" if there was no legal move or the request failed. */
  uci: string;
  scoreCp: number | null;
  depth: number;
  nodes: number;
  error?: string;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<BotRequest>) => void) | null;
  postMessage(msg: BotResponse): void;
};

ctx.onmessage = (e) => {
  const { id, fen, history, botId, timeMs } = e.data;
  try {
    const bot = getBot(botId);
    if (!bot) throw new Error(`Unknown bot: ${botId}`);
    const r = chooseMove(fen, history, bot, { timeMs });
    ctx.postMessage({ id, uci: r.uci, scoreCp: r.scoreCp, depth: r.depth, nodes: r.nodes });
  } catch (err) {
    ctx.postMessage({ id, uci: "", scoreCp: null, depth: 0, nodes: 0, error: String(err) });
  }
};
