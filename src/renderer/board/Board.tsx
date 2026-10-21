// The interactive chessboard: chess.com look and feel, click-to-move and
// drag-and-drop, legal-move hints, premoves, promotion picker, arrows and
// square marks, and move animation. Fully controlled by its props; the only
// internal state is UI state (selection, drag, picker, user drawings).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import "./board.css";
import wK from "../assets/pieces/white-king.png";
import wQ from "../assets/pieces/white-queen.png";
import wR from "../assets/pieces/white-rook.png";
import wB from "../assets/pieces/white-bishop.png";
import wN from "../assets/pieces/white-knight.png";
import wP from "../assets/pieces/white-pawn.png";
import bK from "../assets/pieces/black-king.png";
import bQ from "../assets/pieces/black-queen.png";
import bR from "../assets/pieces/black-rook.png";
import bB from "../assets/pieces/black-bishop.png";
import bN from "../assets/pieces/black-knight.png";
import bP from "../assets/pieces/black-pawn.png";
import {
  applyMove,
  applyPremoves,
  arrowShape,
  castlingAfterPremoves,
  cellToSquare,
  diffMoves,
  isSingleMove,
  moveHints,
  otherSide,
  parseFen,
  placePieces,
  pointToSquare,
  premoveDests,
  promotionPlacement,
  sqIndex,
  sqName,
  squareToCell,
  type PieceCode,
  type Pieces,
  type PlacedPiece,
  type PremoveSpec,
  type Promotion,
  type Side,
} from "./premove";

export type { PieceCode, PremoveSpec, Promotion, Side } from "./premove";

export interface Arrow {
  from: string;
  to: string;
} // from === to means a highlighted square

export interface BoardProps {
  fen: string; // position to display (piece placement + turn are what matter)
  orientation: Side; // which side is at the bottom
  myColor: Side | "both" | "none"; // whose pieces the user may move ("none" = view only)
  dests: Map<string, string[]>; // legal destinations; only meaningful on the user's turn
  lastMove?: [string, string];
  check?: string; // square of the king in check
  premoves: PremoveSpec[]; // controlled premove queue (shown applied on the board)
  premoveEnabled: boolean;
  onPremovesChange?: (p: PremoveSpec[]) => void;
  onMove?: (from: string, to: string, promotion?: Promotion) => void; // only for moves in `dests`
  showLegalMoves: boolean; // dots / capture rings
  showCoordinates: boolean;
  autoQueen: boolean; // skip the promotion picker
  animationMs: number; // 0 disables animation
  arrows?: Arrow[]; // controlled arrows (e.g. replays); otherwise user-drawn ones
}

export const PIECE_IMAGES: Record<PieceCode, string> = { wK, wQ, wR, wB, wN, wP, bK, bQ, bR, bB, bN, bP };

const PIECE_NAMES: Record<string, string> = {
  K: "king",
  Q: "queen",
  R: "rook",
  B: "bishop",
  N: "knight",
  P: "pawn",
};

const DRAG_THRESHOLD_PX = 4;
/** How long an optimistic move is shown if the parent never updates `fen`. */
const OPTIMISTIC_MS = 1500;
const PROMOTION_ORDER: Promotion[] = ["q", "n", "r", "b"];

interface Gesture {
  pointerId: number;
  button: 0 | 2;
  rect: DOMRect;
  startX: number; // client coordinates at press
  startY: number;
  x: number; // board coordinates now
  y: number;
  from: string;
  to: string; // right button: square the arrow currently points at
  code: PieceCode | null; // left button: piece being pressed
  wasSelected: boolean;
  dragging: boolean;
}

interface Snapshot {
  fen: string;
  fenPieces: Pieces;
  display: Pieces;
  lastMove?: [string, string];
  orientation: Side;
  hadPremoves: boolean;
  actionSeq: number;
  pieces: PlacedPiece[];
}

interface UserAction {
  seq: number;
  from: string;
  to: string;
  dragged: boolean;
}

interface Pending {
  fen: string;
  from: string;
  to: string;
  promotion?: Promotion;
}

interface PromoState {
  fen: string;
  from: string;
  to: string;
  color: Side;
}

const sameArrow = (a: Arrow, from: string, to: string) => a.from === from && a.to === to;

export function Board(props: BoardProps) {
  const {
    fen,
    orientation,
    myColor,
    dests,
    lastMove,
    check,
    premoves,
    premoveEnabled,
    onPremovesChange,
    onMove,
    showLegalMoves,
    showCoordinates,
    autoQueen,
    animationMs,
    arrows,
  } = props;

  const rootRef = useRef<HTMLDivElement>(null);
  const dragElRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const hoverRef = useRef<string | null>(null);
  const actionRef = useRef<UserAction>({ seq: 0, from: "", to: "", dragged: false });
  const committedRef = useRef<Snapshot | null>(null);
  const idRef = useRef(0);

  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: string; code: PieceCode } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [promo, setPromo] = useState<PromoState | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [userArrows, setUserArrows] = useState<Arrow[]>([]);
  const [drawing, setDrawing] = useState<Arrow | null>(null);

  // ---- Derived position -------------------------------------------------
  const parsed = useMemo(() => parseFen(fen), [fen]);
  const optimistic = pending && pending.fen === fen ? pending : null;
  const activePromo = promo && promo.fen === fen ? promo : null;
  const premoveKey = premoves.map((p) => `${p.from}${p.to}${p.promotion ?? ""}`).join(",");

  const base = useMemo(() => {
    if (optimistic) {
      return applyMove(parsed.pieces, optimistic.from, optimistic.to, { promotion: optimistic.promotion });
    }
    // While the picker is open the pawn is shown on the promotion square, under the picker.
    if (activePromo) return applyMove(parsed.pieces, activePromo.from, activePromo.to);
    return parsed.pieces;
  }, [parsed, optimistic, activePromo]);

  const display = useMemo(() => (premoves.length ? applyPremoves(base, premoves) : base), [base, premoveKey]);
  const castling = useMemo(() => castlingAfterPremoves(parsed.castling, premoves), [parsed.castling, premoveKey]);

  const turn: Side = optimistic ? otherSide(parsed.turn) : parsed.turn;
  const movable: Side | null =
    myColor === "none" ? null : myColor === "both" ? (optimistic ? null : turn) : myColor;
  const myTurn = movable !== null && movable === turn;
  const premoveMode = !myTurn && premoveEnabled && (myColor === "w" || myColor === "b");
  const interactive = myTurn || premoveMode;
  const pieceSet = myTurn ? base : display;

  const sel =
    selected && interactive && pieceSet[sqIndex(selected)]?.[0] === movable ? selected : null;

  const destsOf = (sq: string): string[] => {
    if (myTurn) return dests.get(sq) ?? [];
    if (premoveMode) return premoveDests(display, sq, castling);
    return [];
  };
  const selDests = useMemo(() => (sel ? destsOf(sel) : []), [sel, myTurn, premoveMode, dests, display, castling]);
  const destSet = useMemo(() => new Set(selDests), [selDests]);

  // ---- Piece layout + animation plan -------------------------------------
  const layout = useMemo<Snapshot>(() => {
    const prev = committedRef.current;
    const act = actionRef.current;
    const newAction = prev !== null && act.seq !== prev.actionSeq;
    const allInstant = prev !== null && prev.orientation !== orientation;
    let hints: [number, number][] = [];
    if (prev && animationMs > 0 && !allInstant) {
      if (prev.fen !== fen) {
        if (lastMove && isSingleMove(prev.fenPieces, parsed.pieces, lastMove[0], lastMove[1])) {
          hints = moveHints(prev.fenPieces, lastMove[0], lastMove[1]);
        } else if (
          prev.lastMove &&
          isSingleMove(parsed.pieces, prev.fenPieces, prev.lastMove[0], prev.lastMove[1])
        ) {
          // Single-move takeback: slide it back.
          hints = moveHints(parsed.pieces, prev.lastMove[0], prev.lastMove[1]).map(
            ([a, b]): [number, number] => [b, a],
          );
        } else if (prev.hadPremoves) {
          // Opponent move and our premove landed together: the premove is
          // already drawn, so animate whatever else moved.
          hints = diffMoves(prev.display, display) ?? [];
        }
      } else if (newAction && !act.dragged) {
        hints = moveHints(prev.display, act.from, act.to);
      }
      if (newAction && act.dragged) {
        // The user dropped this piece where it belongs; never slide it.
        const f = sqIndex(act.from);
        const t = sqIndex(act.to);
        hints = hints.filter(([a, b]) => a !== f || b !== t);
      }
    }
    const pieces = placePieces(prev?.pieces ?? null, display, hints, () => ++idRef.current, allInstant);
    return {
      fen,
      fenPieces: parsed.pieces,
      display,
      lastMove,
      orientation,
      hadPremoves: premoves.length > 0,
      actionSeq: act.seq,
      pieces,
    };
    // Only a change of what is drawn (or the orientation) produces a new layout.
  }, [display, orientation, fen]);

  useLayoutEffect(() => {
    committedRef.current = layout;
  }, [layout]);

  // ---- Housekeeping effects ---------------------------------------------
  useEffect(() => {
    if (!pending) return;
    if (pending.fen !== fen) {
      setPending(null);
      return;
    }
    const t = setTimeout(() => setPending(null), OPTIMISTIC_MS);
    return () => clearTimeout(t);
  }, [pending, fen]);

  useEffect(() => {
    if (promo && promo.fen !== fen) setPromo(null);
  }, [promo, fen]);

  useEffect(() => {
    if (selected && !sel && !gestureRef.current) setSelected(null);
  }, [selected, sel]);

  // ---- Actions -----------------------------------------------------------
  const noteAction = (from: string, to: string, dragged: boolean) => {
    actionRef.current = { seq: actionRef.current.seq + 1, from, to, dragged };
  };

  const commitMove = (from: string, to: string, promotion: Promotion | undefined, dragged: boolean) => {
    noteAction(from, to, dragged);
    setPending({ fen, from, to, promotion });
    setSelected(null);
    onMove?.(from, to, promotion);
  };

  /** Plays or premoves from -> to if allowed. Returns false when it isn't. */
  const tryMove = (from: string, to: string, dragged: boolean): boolean => {
    if (from === to) return false;
    if (myTurn) {
      if (!(dests.get(from) ?? []).includes(to)) return false;
      const piece = base[sqIndex(from)];
      const promotes = piece?.[1] === "P" && (to[1] === "8" || to[1] === "1");
      if (promotes && !autoQueen) {
        setPromo({ fen, from, to, color: piece[0] as Side });
        setSelected(null);
        return true;
      }
      commitMove(from, to, promotes ? "q" : undefined, dragged);
      return true;
    }
    if (premoveMode) {
      const piece = display[sqIndex(from)];
      if (!piece || piece[0] !== movable) return false;
      if (!premoveDests(display, from, castling).includes(to)) return false;
      const promotes = piece[1] === "P" && to[1] === (piece[0] === "w" ? "8" : "1");
      noteAction(from, to, dragged);
      setSelected(null);
      onPremovesChange?.([...premoves, promotes ? { from, to, promotion: "q" } : { from, to }]);
      return true;
    }
    return false;
  };

  const choosePromotion = (role: Promotion) => {
    const p = activePromo;
    setPromo(null);
    if (p) commitMove(p.from, p.to, role, true);
  };

  const endDrag = () => {
    setDrag(null);
    hoverRef.current = null;
    setHover(null);
  };

  const cancelGesture = () => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (g) {
      try {
        rootRef.current?.releasePointerCapture(g.pointerId);
      } catch {
        /* already released */
      }
    }
    endDrag();
    setDrawing(null);
  };

  const clearPremoves = () => {
    if (premoves.length) onPremovesChange?.([]);
  };

  const toggleUserArrow = (from: string, to: string) => {
    setUserArrows((list) =>
      list.some((a) => sameArrow(a, from, to)) ? list.filter((a) => !sameArrow(a, from, to)) : [...list, { from, to }],
    );
  };

  const placeDragEl = () => {
    const g = gestureRef.current;
    const el = dragElRef.current;
    if (!g || !el) return;
    const s = g.rect.width / 8;
    el.style.transform = `translate(${g.x - s / 2}px, ${g.y - s / 2 - s * 0.06}px) scale(1.15)`;
  };

  useLayoutEffect(() => {
    if (drag) placeDragEl();
  }, [drag]);

  // Escape: close the picker, drop the drag, deselect and clear premoves.
  const escapeRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    escapeRef.current = () => {
      if (promo) setPromo(null);
      if (gestureRef.current) cancelGesture();
      setSelected(null);
      clearPremoves();
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") escapeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- Pointer handling ----------------------------------------------------
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root) return;
    const current = gestureRef.current;
    if (current) {
      // A second finger is ignored. Anything else means the previous gesture
      // lost its pointerup (it must never lock the board): drop it and go on.
      if (e.pointerType === "touch" && current.pointerId !== e.pointerId) return;
      cancelGesture();
    }
    if (e.button !== 0 && e.button !== 2) return;
    const rect = root.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const sq = pointToSquare(x, y, rect.width, rect.height, orientation);
    const gesture = (button: 0 | 2, from: string, code: PieceCode | null): Gesture => ({
      pointerId: e.pointerId,
      button,
      rect,
      startX: e.clientX,
      startY: e.clientY,
      x,
      y,
      from,
      to: from,
      code,
      wasSelected: sel === from,
      dragging: false,
    });

    if (promo) {
      // Any press outside the picker (which stops propagation) cancels it.
      setPromo(null);
      return;
    }

    if (e.button === 2) {
      if (premoves.length || sel) {
        clearPremoves();
        setSelected(null);
        if (premoves.length) return;
      }
      if (arrows !== undefined || !sq) return;
      try {
        root.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer */
      }
      gestureRef.current = gesture(2, sq, null);
      setDrawing({ from: sq, to: sq });
      return;
    }

    if (userArrows.length) setUserArrows([]);
    if (!sq) return;
    const piece = pieceSet[sqIndex(sq)];
    const ownPiece = interactive && !!piece && piece[0] === movable;
    // Clicking an own piece always selects it; premoving onto an own piece
    // (a recapture) is done by dragging.
    if (sel && sel !== sq && destSet.has(sq) && !ownPiece) {
      tryMove(sel, sq, false);
      return;
    }
    if (ownPiece && piece) {
      try {
        root.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer */
      }
      gestureRef.current = gesture(0, sq, piece);
      if (sel !== sq) setSelected(sq);
      return;
    }
    if (selected) setSelected(null);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const x = e.clientX - g.rect.left;
    const y = e.clientY - g.rect.top;
    const sq = pointToSquare(x, y, g.rect.width, g.rect.height, orientation);
    if (g.button === 2) {
      if (sq && sq !== g.to) {
        g.to = sq;
        setDrawing({ from: g.from, to: sq });
      }
      return;
    }
    if (e.buttons & 2) {
      cancelGesture(); // right button pressed while dragging
      setSelected(null);
      return;
    }
    g.x = x;
    g.y = y;
    if (!g.dragging) {
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < DRAG_THRESHOLD_PX) return;
      g.dragging = true;
      if (g.code) setDrag({ from: g.from, code: g.code }); // the layout effect positions it
    } else {
      placeDragEl();
    }
    if (sq !== hoverRef.current) {
      hoverRef.current = sq;
      setHover(sq);
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gestureRef.current = null;
    try {
      rootRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    const x = e.clientX - g.rect.left;
    const y = e.clientY - g.rect.top;
    const sq = pointToSquare(x, y, g.rect.width, g.rect.height, orientation);
    if (g.button === 2) {
      setDrawing(null);
      if (sq) toggleUserArrow(g.from, sq);
      return;
    }
    if (!g.dragging) {
      if (g.wasSelected) setSelected(null);
      return;
    }
    endDrag();
    if (sq && sq !== g.from && tryMove(g.from, sq, true)) return;
    if (sq === g.from && !g.wasSelected) return; // dropped back: stays selected
    setSelected(null);
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    cancelGesture();
  };

  // ---- Rendering -------------------------------------------------------------
  const shownLastMove: [string, string] | undefined = optimistic ? [optimistic.from, optimistic.to] : lastMove;
  const premoveSquares = useMemo(() => {
    const s = new Set<string>();
    for (const p of premoves) {
      s.add(p.from);
      s.add(p.to);
    }
    return s;
  }, [premoveKey]);

  const drawn = arrows ?? (drawing && !userArrows.some((a) => sameArrow(a, drawing.from, drawing.to))
    ? [...userArrows, drawing]
    : userArrows);
  const marks = new Set<string>();
  const lines: Arrow[] = [];
  for (const a of drawn) {
    if (a.from === a.to) marks.add(a.from);
    else lines.push(a);
  }

  const dragFrom = drag ? sqIndex(drag.from) : -1;
  const rows = [];
  for (let row = 0; row < 8; row++) {
    const cells = [];
    for (let col = 0; col < 8; col++) {
      const sq = cellToSquare(col, row, orientation)!;
      const i = sqIndex(sq);
      const dark = ((i & 7) + (i >> 3)) % 2 === 0;
      const isLast = !!shownLastMove && (shownLastMove[0] === sq || shownLastMove[1] === sq);
      const isSel = sel === sq;
      const isPre = premoveSquares.has(sq);
      const isDest = destSet.has(sq);
      const occupant = display[i];
      const canGrab = interactive && occupant?.[0] === movable;
      let cls = dark ? "cl-sq cl-d" : "cl-sq cl-l";
      if (isLast || isSel) cls += " cl-hl";
      if (hover === sq && drag) cls += " cl-hover";
      if (canGrab) cls += " cl-grab";
      cells.push(
        <div
          key={sq}
          role="gridcell"
          className={cls}
          data-square={sq}
          data-occupant={occupant ?? undefined}
          data-last-move={isLast ? "" : undefined}
          data-selected={isSel ? "" : undefined}
          data-premove={isPre ? "" : undefined}
          data-dest={isDest ? "" : undefined}
          data-marked={marks.has(sq) ? "" : undefined}
          data-check={check === sq ? "" : undefined}
          aria-label={occupant ? `${sq} ${occupant[0] === "w" ? "white" : "black"} ${PIECE_NAMES[occupant[1]]}` : sq}
          aria-selected={isSel}
        >
          {isPre && <i className="cl-ov cl-ov-pre" />}
          {marks.has(sq) && <i className="cl-ov cl-ov-mark" />}
          {check === sq && <i className="cl-ov cl-ov-check" />}
          {isDest && showLegalMoves && <i className={occupant ? "cl-ring" : "cl-dot"} />}
          {showCoordinates && col === 0 && <span className="cl-coord cl-coord-rank">{sq[1]}</span>}
          {showCoordinates && row === 7 && <span className="cl-coord cl-coord-file">{sq[0]}</span>}
        </div>,
      );
    }
    rows.push(
      <div key={row} role="row" className="cl-row">
        {cells}
      </div>,
    );
  }

  const transition = animationMs > 0 ? `transform ${animationMs}ms ease-out` : "none";
  const pieceEls = layout.pieces.map((p) => {
    const { col, row } = squareToCell(p.sq, orientation);
    const style: CSSProperties = {
      transform: `translate(${col * 100}%, ${row * 100}%)`,
      transition: p.motion === "instant" ? "none" : transition,
      backgroundImage: `url(${PIECE_IMAGES[p.code]})`,
      zIndex: p.motion === "animate" ? 2 : undefined,
    };
    return (
      <div
        key={p.id}
        className={p.sq === dragFrom ? "cl-piece cl-ghost" : "cl-piece"}
        data-piece={p.code}
        data-piece-square={sqName(p.sq)}
        style={style}
      />
    );
  });

  let picker = null;
  if (activePromo) {
    const { col, fromTop } = promotionPlacement(activePromo.to, orientation);
    const style: CSSProperties = { left: `${col * 12.5}%`, ...(fromTop ? { top: 0 } : { bottom: 0 }) };
    picker = (
      <>
        <div className="cl-promo-backdrop" />
        <div
          className={fromTop ? "cl-promo" : "cl-promo cl-promo-up"}
          style={style}
          role="dialog"
          aria-label="Promote to"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {PROMOTION_ORDER.map((r) => {
            const code = `${activePromo.color}${r.toUpperCase()}` as PieceCode;
            return (
              <button
                key={r}
                type="button"
                className="cl-promo-piece"
                data-promotion={r}
                aria-label={PIECE_NAMES[r.toUpperCase()]}
                style={{ backgroundImage: `url(${PIECE_IMAGES[code]})` }}
                onClick={() => choosePromotion(r)}
              />
            );
          })}
          <button
            type="button"
            className="cl-promo-cancel"
            data-promotion="cancel"
            aria-label="Cancel"
            onClick={() => setPromo(null)}
          >
            ✕
          </button>
        </div>
      </>
    );
  }

  return (
    <div
      ref={rootRef}
      className={drag ? "cl-board cl-dragging" : "cl-board"}
      role="grid"
      aria-label="Chess board"
      data-orientation={orientation}
      data-turn={parsed.turn}
      data-premove-mode={premoveMode ? "" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={(e) => {
        // Only the board itself losing capture matters; a square losing a
        // touch's implicit capture to the board bubbles up here too.
        if (e.target === e.currentTarget) onPointerCancel(e);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="cl-squares">{rows}</div>
      <div className="cl-pieces">{pieceEls}</div>
      {lines.length > 0 && (
        <svg className="cl-arrows" viewBox="0 0 8 8" aria-hidden="true">
          {lines.map((a, i) => {
            const s = arrowShape(a.from, a.to, orientation);
            return (
              <g key={`${a.from}${a.to}${i}`} className="cl-arrow" data-arrow={`${a.from}${a.to}`}>
                <polyline points={s.shaft} />
                <polygon points={s.head} />
              </g>
            );
          })}
        </svg>
      )}
      {drag && (
        <div
          ref={dragElRef}
          className="cl-drag"
          style={{ backgroundImage: `url(${PIECE_IMAGES[drag.code]})` }}
        />
      )}
      {picker}
    </div>
  );
}
