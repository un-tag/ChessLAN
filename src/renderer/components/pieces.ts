// Kiwen-Suwi piece images (CC BY 4.0, see README) for UI outside the board.
import bB from "../assets/pieces/black-bishop.png";
import bK from "../assets/pieces/black-king.png";
import bN from "../assets/pieces/black-knight.png";
import bP from "../assets/pieces/black-pawn.png";
import bQ from "../assets/pieces/black-queen.png";
import bR from "../assets/pieces/black-rook.png";
import wB from "../assets/pieces/white-bishop.png";
import wK from "../assets/pieces/white-king.png";
import wN from "../assets/pieces/white-knight.png";
import wP from "../assets/pieces/white-pawn.png";
import wQ from "../assets/pieces/white-queen.png";
import wR from "../assets/pieces/white-rook.png";
import type { PieceSymbol, Side } from "../../shared/chess/game";

const IMAGES: Record<string, string> = { bB, bK, bN, bP, bQ, bR, wB, wK, wN, wP, wQ, wR };

export const pieceImage = (color: Side, type: PieceSymbol): string => IMAGES[color + type.toUpperCase()];
