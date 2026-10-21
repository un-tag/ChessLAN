import type { EndReason, Result, Side } from "../../shared/chess/game";
import type { GameRecord } from "../../shared/protocol";

export type Outcome = "win" | "loss" | "draw";

export function resultFor(result: Result | undefined, side: Side): Outcome {
  if (result === "1-0") return side === "w" ? "win" : "loss";
  if (result === "0-1") return side === "b" ? "win" : "loss";
  return "draw";
}

export function recordOutcome(r: GameRecord, playerId: string): Outcome {
  return resultFor(r.result, r.white.id === playerId ? "w" : "b");
}

const REASONS: Record<EndReason, string> = {
  checkmate: "by checkmate",
  stalemate: "by stalemate",
  repetition: "by repetition",
  fifty: "by the 50-move rule",
  insufficient: "by insufficient material",
  resign: "by resignation",
  timeout: "on time",
  "timeout-insufficient": "timeout vs insufficient material",
  agreement: "by agreement",
  abandon: "game abandoned",
};

export function reasonText(reason: EndReason | "aborted" | undefined): string {
  if (!reason || reason === "aborted") return "";
  return REASONS[reason];
}
