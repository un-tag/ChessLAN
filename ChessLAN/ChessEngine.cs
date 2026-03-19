using System;
using System.Collections.Generic;
using System.Text;

namespace ChessLAN
{
    public enum PieceType { None, Pawn, Knight, Bishop, Rook, Queen, King }
    public enum PieceColor { None, White, Black }

    public struct Piece
    {
        public PieceType Type;
        public PieceColor Color;
        public bool IsEmpty => Type == PieceType.None;
        public static Piece Empty => new() { Type = PieceType.None, Color = PieceColor.None };
    }

    public struct Move
    {
        public int FromRow, FromCol, ToRow, ToCol;
        public PieceType Promotion; // PieceType.None if not a promotion

        public string ToAlgebraic()
        {
            char fromFile = (char)('a' + FromCol);
            char fromRank = (char)('1' + FromRow);
            char toFile = (char)('a' + ToCol);
            char toRank = (char)('1' + ToRow);
            string s = $"{fromFile}{fromRank}{toFile}{toRank}";
            if (Promotion != PieceType.None)
            {
                char p = Promotion switch
                {
                    PieceType.Queen => 'q',
                    PieceType.Rook => 'r',
                    PieceType.Bishop => 'b',
                    PieceType.Knight => 'n',
                    _ => ' '
                };
                s += p;
            }
            return s;
        }

        public static Move FromAlgebraic(string s)
        {
            Move m = new();
            m.FromCol = s[0] - 'a';
            m.FromRow = s[1] - '1';
            m.ToCol = s[2] - 'a';
            m.ToRow = s[3] - '1';
            m.Promotion = PieceType.None;
            if (s.Length > 4)
            {
                m.Promotion = s[4] switch
                {
                    'q' or 'Q' => PieceType.Queen,
                    'r' or 'R' => PieceType.Rook,
                    'b' or 'B' => PieceType.Bishop,
                    'n' or 'N' => PieceType.Knight,
                    _ => PieceType.None
                };
            }
            return m;
        }

        public override bool Equals(object? obj)
        {
            if (obj is Move other)
                return FromRow == other.FromRow && FromCol == other.FromCol
                    && ToRow == other.ToRow && ToCol == other.ToCol
                    && Promotion == other.Promotion;
            return false;
        }

        public override int GetHashCode()
        {
            return HashCode.Combine(FromRow, FromCol, ToRow, ToCol, Promotion);
        }

        public static bool operator ==(Move a, Move b) => a.Equals(b);
        public static bool operator !=(Move a, Move b) => !a.Equals(b);
    }

    public class MoveResult
    {
        public bool IsCapture;
        public bool IsCheck;
        public bool IsCheckmate;
        public bool IsStalemate;
        public bool IsDraw;
        public bool IsCastle;
        public bool IsEnPassant;
        public bool IsPromotion;
        public Piece CapturedPiece;
        public string? GameOverReason;
    }

    public class ChessBoard
    {
        private Piece[,] _squares = new Piece[8, 8];
        public PieceColor Turn { get; private set; } = PieceColor.White;

        public bool WhiteKingSide = true, WhiteQueenSide = true;
        public bool BlackKingSide = true, BlackQueenSide = true;

        public (int Row, int Col)? EnPassantTarget;

        public int HalfmoveClock;
        public int FullmoveNumber = 1;

        private List<string> _positionHistory = new();

        private (int Row, int Col) _whiteKingPos = (-1, -1);
        private (int Row, int Col) _blackKingPos = (-1, -1);

        private struct UndoState
        {
            public Piece FromPiece;
            public Piece ToPiece;
            public Piece CapturedEnPassantPiece;
            public int CapturedEnPassantRow;
            public int CapturedEnPassantCol;
            public bool WasEnPassant;
            public bool WasCastle;
            public int RookFromCol;
            public int RookToCol;
            public Piece RookPiece;
            public (int Row, int Col)? PrevEnPassantTarget;
            public (int Row, int Col) PrevWhiteKingPos;
            public (int Row, int Col) PrevBlackKingPos;
        }

        public ChessBoard()
        {
            for (int r = 0; r < 8; r++)
                for (int c = 0; c < 8; c++)
                    _squares[r, c] = Piece.Empty;
        }

        public Piece GetPiece(int row, int col) => _squares[row, col];

        public void SetPiece(int row, int col, Piece piece) => _squares[row, col] = piece;

        public void SetupInitialPosition()
        {
            for (int r = 0; r < 8; r++)
                for (int c = 0; c < 8; c++)
                    _squares[r, c] = Piece.Empty;

            PieceType[] backRank = {
                PieceType.Rook, PieceType.Knight, PieceType.Bishop, PieceType.Queen,
                PieceType.King, PieceType.Bishop, PieceType.Knight, PieceType.Rook
            };

            for (int c = 0; c < 8; c++)
            {
                _squares[0, c] = new Piece { Type = backRank[c], Color = PieceColor.White };
                _squares[1, c] = new Piece { Type = PieceType.Pawn, Color = PieceColor.White };
                _squares[6, c] = new Piece { Type = PieceType.Pawn, Color = PieceColor.Black };
                _squares[7, c] = new Piece { Type = backRank[c], Color = PieceColor.Black };
            }

            Turn = PieceColor.White;
            WhiteKingSide = true; WhiteQueenSide = true;
            BlackKingSide = true; BlackQueenSide = true;
            EnPassantTarget = null;
            HalfmoveClock = 0;
            FullmoveNumber = 1;
            _whiteKingPos = (0, 4);
            _blackKingPos = (7, 4);
            _positionHistory.Clear();
            _positionHistory.Add(GetPositionKey());
        }

        private static bool InBounds(int r, int c) => r >= 0 && r < 8 && c >= 0 && c < 8;

        private static PieceColor Opposite(PieceColor color) =>
            color == PieceColor.White ? PieceColor.Black : PieceColor.White;

        // ────────────────────────────────────────────────
        // Pseudo-legal move generation
        // ────────────────────────────────────────────────

        private List<Move> GetPseudoLegalMoves(PieceColor color)
        {
            var moves = new List<Move>();
            for (int r = 0; r < 8; r++)
                for (int c = 0; c < 8; c++)
                    if (_squares[r, c].Color == color)
                        GetPseudoLegalMoves(r, c, moves);
            return moves;
        }

        private void GetPseudoLegalMoves(int row, int col, List<Move> moves)
        {
            Piece p = _squares[row, col];
            if (p.IsEmpty) return;

            switch (p.Type)
            {
                case PieceType.Pawn:   GeneratePawnMoves(row, col, p.Color, moves); break;
                case PieceType.Knight: GenerateKnightMoves(row, col, p.Color, moves); break;
                case PieceType.Bishop: GenerateSlidingMoves(row, col, p.Color, moves, bishop: true, rook: false); break;
                case PieceType.Rook:   GenerateSlidingMoves(row, col, p.Color, moves, bishop: false, rook: true); break;
                case PieceType.Queen:  GenerateSlidingMoves(row, col, p.Color, moves, bishop: true, rook: true); break;
                case PieceType.King:   GenerateKingMoves(row, col, p.Color, moves); break;
            }
        }

        private void GeneratePawnMoves(int row, int col, PieceColor color, List<Move> moves)
        {
            int dir = color == PieceColor.White ? 1 : -1;
            int startRow = color == PieceColor.White ? 1 : 6;
            int promoRow = color == PieceColor.White ? 7 : 0;

            // Forward 1
            int nr = row + dir;
            if (InBounds(nr, col) && _squares[nr, col].IsEmpty)
            {
                if (nr == promoRow)
                    AddPromotionMoves(row, col, nr, col, moves);
                else
                    moves.Add(new Move { FromRow = row, FromCol = col, ToRow = nr, ToCol = col, Promotion = PieceType.None });

                // Forward 2 from starting row
                int nr2 = row + 2 * dir;
                if (row == startRow && InBounds(nr2, col) && _squares[nr2, col].IsEmpty)
                    moves.Add(new Move { FromRow = row, FromCol = col, ToRow = nr2, ToCol = col, Promotion = PieceType.None });
            }

            // Diagonal captures
            foreach (int dc in new[] { -1, 1 })
            {
                int nc = col + dc;
                if (!InBounds(nr, nc)) continue;

                if (!_squares[nr, nc].IsEmpty && _squares[nr, nc].Color != color)
                {
                    if (nr == promoRow)
                        AddPromotionMoves(row, col, nr, nc, moves);
                    else
                        moves.Add(new Move { FromRow = row, FromCol = col, ToRow = nr, ToCol = nc, Promotion = PieceType.None });
                }

                // En passant
                if (EnPassantTarget.HasValue && EnPassantTarget.Value.Row == nr && EnPassantTarget.Value.Col == nc)
                    moves.Add(new Move { FromRow = row, FromCol = col, ToRow = nr, ToCol = nc, Promotion = PieceType.None });
            }
        }

        private void AddPromotionMoves(int fromRow, int fromCol, int toRow, int toCol, List<Move> moves)
        {
            moves.Add(new Move { FromRow = fromRow, FromCol = fromCol, ToRow = toRow, ToCol = toCol, Promotion = PieceType.Queen });
            moves.Add(new Move { FromRow = fromRow, FromCol = fromCol, ToRow = toRow, ToCol = toCol, Promotion = PieceType.Rook });
            moves.Add(new Move { FromRow = fromRow, FromCol = fromCol, ToRow = toRow, ToCol = toCol, Promotion = PieceType.Bishop });
            moves.Add(new Move { FromRow = fromRow, FromCol = fromCol, ToRow = toRow, ToCol = toCol, Promotion = PieceType.Knight });
        }

        private static readonly int[][] KnightOffsets = {
            new[] {-2,-1}, new[] {-2,1}, new[] {-1,-2}, new[] {-1,2},
            new[] {1,-2}, new[] {1,2}, new[] {2,-1}, new[] {2,1}
        };

        private void GenerateKnightMoves(int row, int col, PieceColor color, List<Move> moves)
        {
            foreach (var off in KnightOffsets)
            {
                int nr = row + off[0], nc = col + off[1];
                if (InBounds(nr, nc) && _squares[nr, nc].Color != color)
                    moves.Add(new Move { FromRow = row, FromCol = col, ToRow = nr, ToCol = nc, Promotion = PieceType.None });
            }
        }

        private static readonly int[][] BishopDirs = { new[] {1,1}, new[] {1,-1}, new[] {-1,1}, new[] {-1,-1} };
        private static readonly int[][] RookDirs = { new[] {1,0}, new[] {-1,0}, new[] {0,1}, new[] {0,-1} };

        private void GenerateSlidingMoves(int row, int col, PieceColor color, List<Move> moves, bool bishop, bool rook)
        {
            var dirs = new List<int[]>();
            if (bishop) dirs.AddRange(BishopDirs);
            if (rook) dirs.AddRange(RookDirs);

            foreach (var d in dirs)
            {
                int nr = row + d[0], nc = col + d[1];
                while (InBounds(nr, nc))
                {
                    if (_squares[nr, nc].IsEmpty)
                    {
                        moves.Add(new Move { FromRow = row, FromCol = col, ToRow = nr, ToCol = nc, Promotion = PieceType.None });
                    }
                    else
                    {
                        if (_squares[nr, nc].Color != color)
                            moves.Add(new Move { FromRow = row, FromCol = col, ToRow = nr, ToCol = nc, Promotion = PieceType.None });
                        break;
                    }
                    nr += d[0]; nc += d[1];
                }
            }
        }

        private void GenerateKingMoves(int row, int col, PieceColor color, List<Move> moves)
        {
            for (int dr = -1; dr <= 1; dr++)
                for (int dc = -1; dc <= 1; dc++)
                {
                    if (dr == 0 && dc == 0) continue;
                    int nr = row + dr, nc = col + dc;
                    if (InBounds(nr, nc) && _squares[nr, nc].Color != color)
                        moves.Add(new Move { FromRow = row, FromCol = col, ToRow = nr, ToCol = nc, Promotion = PieceType.None });
                }

            // Castling
            if (color == PieceColor.White && row == 0 && col == 4)
            {
                // Kingside
                if (WhiteKingSide
                    && _squares[0, 5].IsEmpty && _squares[0, 6].IsEmpty
                    && _squares[0, 7].Type == PieceType.Rook && _squares[0, 7].Color == PieceColor.White
                    && !IsSquareAttacked(0, 4, PieceColor.Black)
                    && !IsSquareAttacked(0, 5, PieceColor.Black)
                    && !IsSquareAttacked(0, 6, PieceColor.Black))
                {
                    moves.Add(new Move { FromRow = 0, FromCol = 4, ToRow = 0, ToCol = 6, Promotion = PieceType.None });
                }
                // Queenside
                if (WhiteQueenSide
                    && _squares[0, 3].IsEmpty && _squares[0, 2].IsEmpty && _squares[0, 1].IsEmpty
                    && _squares[0, 0].Type == PieceType.Rook && _squares[0, 0].Color == PieceColor.White
                    && !IsSquareAttacked(0, 4, PieceColor.Black)
                    && !IsSquareAttacked(0, 3, PieceColor.Black)
                    && !IsSquareAttacked(0, 2, PieceColor.Black))
                {
                    moves.Add(new Move { FromRow = 0, FromCol = 4, ToRow = 0, ToCol = 2, Promotion = PieceType.None });
                }
            }
            else if (color == PieceColor.Black && row == 7 && col == 4)
            {
                if (BlackKingSide
                    && _squares[7, 5].IsEmpty && _squares[7, 6].IsEmpty
                    && _squares[7, 7].Type == PieceType.Rook && _squares[7, 7].Color == PieceColor.Black
                    && !IsSquareAttacked(7, 4, PieceColor.White)
                    && !IsSquareAttacked(7, 5, PieceColor.White)
                    && !IsSquareAttacked(7, 6, PieceColor.White))
                {
                    moves.Add(new Move { FromRow = 7, FromCol = 4, ToRow = 7, ToCol = 6, Promotion = PieceType.None });
                }
                if (BlackQueenSide
                    && _squares[7, 3].IsEmpty && _squares[7, 2].IsEmpty && _squares[7, 1].IsEmpty
                    && _squares[7, 0].Type == PieceType.Rook && _squares[7, 0].Color == PieceColor.Black
                    && !IsSquareAttacked(7, 4, PieceColor.White)
                    && !IsSquareAttacked(7, 3, PieceColor.White)
                    && !IsSquareAttacked(7, 2, PieceColor.White))
                {
                    moves.Add(new Move { FromRow = 7, FromCol = 4, ToRow = 7, ToCol = 2, Promotion = PieceType.None });
                }
            }
        }

        // ────────────────────────────────────────────────
        // Attack detection
        // ────────────────────────────────────────────────

        /// <summary>
        /// Returns true if the given square is attacked by any piece of the specified attacking color.
        /// </summary>
        public bool IsSquareAttacked(int row, int col, PieceColor attackerColor)
        {
            // Knight attacks
            foreach (var off in KnightOffsets)
            {
                int nr = row + off[0], nc = col + off[1];
                if (InBounds(nr, nc) && _squares[nr, nc].Color == attackerColor && _squares[nr, nc].Type == PieceType.Knight)
                    return true;
            }

            // Pawn attacks
            int pawnDir = attackerColor == PieceColor.White ? 1 : -1;
            // An attacker pawn at (row - pawnDir, col +/- 1) attacks this square
            int pr = row - pawnDir;
            if (InBounds(pr, col - 1) && _squares[pr, col - 1].Color == attackerColor && _squares[pr, col - 1].Type == PieceType.Pawn)
                return true;
            if (InBounds(pr, col + 1) && _squares[pr, col + 1].Color == attackerColor && _squares[pr, col + 1].Type == PieceType.Pawn)
                return true;

            // King attacks
            for (int dr = -1; dr <= 1; dr++)
                for (int dc = -1; dc <= 1; dc++)
                {
                    if (dr == 0 && dc == 0) continue;
                    int nr = row + dr, nc = col + dc;
                    if (InBounds(nr, nc) && _squares[nr, nc].Color == attackerColor && _squares[nr, nc].Type == PieceType.King)
                        return true;
                }

            // Sliding attacks: bishop/queen on diagonals
            foreach (var d in BishopDirs)
            {
                int nr = row + d[0], nc = col + d[1];
                while (InBounds(nr, nc))
                {
                    if (!_squares[nr, nc].IsEmpty)
                    {
                        if (_squares[nr, nc].Color == attackerColor &&
                            (_squares[nr, nc].Type == PieceType.Bishop || _squares[nr, nc].Type == PieceType.Queen))
                            return true;
                        break;
                    }
                    nr += d[0]; nc += d[1];
                }
            }

            // Sliding attacks: rook/queen on ranks/files
            foreach (var d in RookDirs)
            {
                int nr = row + d[0], nc = col + d[1];
                while (InBounds(nr, nc))
                {
                    if (!_squares[nr, nc].IsEmpty)
                    {
                        if (_squares[nr, nc].Color == attackerColor &&
                            (_squares[nr, nc].Type == PieceType.Rook || _squares[nr, nc].Type == PieceType.Queen))
                            return true;
                        break;
                    }
                    nr += d[0]; nc += d[1];
                }
            }

            return false;
        }

        // ────────────────────────────────────────────────
        // King location helper
        // ────────────────────────────────────────────────

        private (int Row, int Col) FindKing(PieceColor color)
        {
            if (color == PieceColor.White && _whiteKingPos.Row >= 0)
                return _whiteKingPos;
            if (color == PieceColor.Black && _blackKingPos.Row >= 0)
                return _blackKingPos;

            for (int r = 0; r < 8; r++)
                for (int c = 0; c < 8; c++)
                    if (_squares[r, c].Type == PieceType.King && _squares[r, c].Color == color)
                    {
                        if (color == PieceColor.White) _whiteKingPos = (r, c);
                        else _blackKingPos = (r, c);
                        return (r, c);
                    }
            return (-1, -1);
        }

        private void UpdateKingCache(PieceColor color, int row, int col)
        {
            if (color == PieceColor.White)
                _whiteKingPos = (row, col);
            else
                _blackKingPos = (row, col);
        }

        // ────────────────────────────────────────────────
        // Legal move generation
        // ────────────────────────────────────────────────

        public List<Move> GetLegalMoves()
        {
            var pseudo = GetPseudoLegalMoves(Turn);
            var legal = new List<Move>();
            foreach (var move in pseudo)
            {
                if (IsMoveLegal(move))
                    legal.Add(move);
            }
            return legal;
        }

        public List<Move> GetLegalMoves(int row, int col)
        {
            Piece p = _squares[row, col];
            if (p.IsEmpty || p.Color != Turn) return new List<Move>();

            var pseudo = new List<Move>();
            GetPseudoLegalMoves(row, col, pseudo);
            var legal = new List<Move>();
            foreach (var move in pseudo)
            {
                if (IsMoveLegal(move))
                    legal.Add(move);
            }
            return legal;
        }

        private bool IsMoveLegal(Move move)
        {
            PieceColor mover = Turn;
            var undo = ApplyMoveRaw(move);
            var king = FindKing(mover);
            bool legal = king.Row >= 0 && !IsSquareAttacked(king.Row, king.Col, Opposite(mover));
            UndoMoveRaw(move, undo);
            return legal;
        }

        private UndoState ApplyMoveRaw(Move move)
        {
            Piece piece = _squares[move.FromRow, move.FromCol];

            var undo = new UndoState
            {
                FromPiece = piece,
                ToPiece = _squares[move.ToRow, move.ToCol],
                PrevEnPassantTarget = EnPassantTarget,
                PrevWhiteKingPos = _whiteKingPos,
                PrevBlackKingPos = _blackKingPos,
                WasEnPassant = false,
                WasCastle = false,
            };

            // En passant capture
            if (piece.Type == PieceType.Pawn && EnPassantTarget.HasValue
                && move.ToRow == EnPassantTarget.Value.Row && move.ToCol == EnPassantTarget.Value.Col)
            {
                int capturedPawnRow = piece.Color == PieceColor.White ? move.ToRow - 1 : move.ToRow + 1;
                undo.WasEnPassant = true;
                undo.CapturedEnPassantPiece = _squares[capturedPawnRow, move.ToCol];
                undo.CapturedEnPassantRow = capturedPawnRow;
                undo.CapturedEnPassantCol = move.ToCol;
                _squares[capturedPawnRow, move.ToCol] = Piece.Empty;
            }

            // Castling rook movement
            if (piece.Type == PieceType.King && Math.Abs(move.ToCol - move.FromCol) == 2)
            {
                undo.WasCastle = true;
                if (move.ToCol > move.FromCol) { undo.RookFromCol = 7; undo.RookToCol = 5; }
                else { undo.RookFromCol = 0; undo.RookToCol = 3; }
                undo.RookPiece = _squares[move.FromRow, undo.RookFromCol];
                _squares[move.FromRow, undo.RookToCol] = _squares[move.FromRow, undo.RookFromCol];
                _squares[move.FromRow, undo.RookFromCol] = Piece.Empty;
            }

            // Move the piece
            _squares[move.ToRow, move.ToCol] = piece;
            _squares[move.FromRow, move.FromCol] = Piece.Empty;

            // Promotion
            if (move.Promotion != PieceType.None)
                _squares[move.ToRow, move.ToCol] = new Piece { Type = move.Promotion, Color = piece.Color };

            // Update king cache
            if (piece.Type == PieceType.King)
                UpdateKingCache(piece.Color, move.ToRow, move.ToCol);

            return undo;
        }

        private void UndoMoveRaw(Move move, UndoState undo)
        {
            // Restore moved piece
            _squares[move.FromRow, move.FromCol] = undo.FromPiece;
            _squares[move.ToRow, move.ToCol] = undo.ToPiece;

            // Undo en passant capture
            if (undo.WasEnPassant)
                _squares[undo.CapturedEnPassantRow, undo.CapturedEnPassantCol] = undo.CapturedEnPassantPiece;

            // Undo castling rook movement
            if (undo.WasCastle)
            {
                _squares[move.FromRow, undo.RookFromCol] = undo.RookPiece;
                _squares[move.FromRow, undo.RookToCol] = Piece.Empty;
            }

            // Restore state
            EnPassantTarget = undo.PrevEnPassantTarget;
            _whiteKingPos = undo.PrevWhiteKingPos;
            _blackKingPos = undo.PrevBlackKingPos;
        }

        // ────────────────────────────────────────────────
        // MakeMove (full state update)
        // ────────────────────────────────────────────────

        public MoveResult MakeMove(Move move)
        {
            var result = new MoveResult();
            Piece movingPiece = _squares[move.FromRow, move.FromCol];
            Piece targetPiece = _squares[move.ToRow, move.ToCol];

            // Detect en passant
            bool isEnPassant = movingPiece.Type == PieceType.Pawn
                && EnPassantTarget.HasValue
                && move.ToRow == EnPassantTarget.Value.Row
                && move.ToCol == EnPassantTarget.Value.Col;

            // Detect castling
            bool isCastle = movingPiece.Type == PieceType.King && Math.Abs(move.ToCol - move.FromCol) == 2;

            // Detect capture
            bool isCapture = !targetPiece.IsEmpty || isEnPassant;
            Piece capturedPiece = targetPiece;

            if (isEnPassant)
            {
                int capturedRow = movingPiece.Color == PieceColor.White ? move.ToRow - 1 : move.ToRow + 1;
                capturedPiece = _squares[capturedRow, move.ToCol];
                _squares[capturedRow, move.ToCol] = Piece.Empty;
            }

            // Detect promotion
            bool isPromotion = move.Promotion != PieceType.None;

            // Move the rook for castling
            if (isCastle)
            {
                int rookFromCol, rookToCol;
                if (move.ToCol > move.FromCol) { rookFromCol = 7; rookToCol = 5; }
                else { rookFromCol = 0; rookToCol = 3; }
                _squares[move.FromRow, rookToCol] = _squares[move.FromRow, rookFromCol];
                _squares[move.FromRow, rookFromCol] = Piece.Empty;
            }

            // Move the piece
            _squares[move.ToRow, move.ToCol] = movingPiece;
            _squares[move.FromRow, move.FromCol] = Piece.Empty;

            // Promotion
            if (isPromotion)
                _squares[move.ToRow, move.ToCol] = new Piece { Type = move.Promotion, Color = movingPiece.Color };

            // Update king cache
            if (movingPiece.Type == PieceType.King)
                UpdateKingCache(movingPiece.Color, move.ToRow, move.ToCol);

            // ── Update castling rights ──

            // King moved
            if (movingPiece.Type == PieceType.King)
            {
                if (movingPiece.Color == PieceColor.White) { WhiteKingSide = false; WhiteQueenSide = false; }
                else { BlackKingSide = false; BlackQueenSide = false; }
            }

            // Rook moved from its original square
            if (movingPiece.Type == PieceType.Rook)
            {
                if (movingPiece.Color == PieceColor.White)
                {
                    if (move.FromRow == 0 && move.FromCol == 7) WhiteKingSide = false;
                    if (move.FromRow == 0 && move.FromCol == 0) WhiteQueenSide = false;
                }
                else
                {
                    if (move.FromRow == 7 && move.FromCol == 7) BlackKingSide = false;
                    if (move.FromRow == 7 && move.FromCol == 0) BlackQueenSide = false;
                }
            }

            // Rook captured on its original square
            if (move.ToRow == 0 && move.ToCol == 7) WhiteKingSide = false;
            if (move.ToRow == 0 && move.ToCol == 0) WhiteQueenSide = false;
            if (move.ToRow == 7 && move.ToCol == 7) BlackKingSide = false;
            if (move.ToRow == 7 && move.ToCol == 0) BlackQueenSide = false;

            // ── Update en passant target ──
            if (movingPiece.Type == PieceType.Pawn && Math.Abs(move.ToRow - move.FromRow) == 2)
            {
                int epRow = (move.FromRow + move.ToRow) / 2;
                EnPassantTarget = (epRow, move.FromCol);
            }
            else
            {
                EnPassantTarget = null;
            }

            // ── Halfmove clock ──
            if (movingPiece.Type == PieceType.Pawn || isCapture)
                HalfmoveClock = 0;
            else
                HalfmoveClock++;

            // ── Fullmove number ──
            if (Turn == PieceColor.Black)
                FullmoveNumber++;

            // ── Switch turn ──
            Turn = Opposite(Turn);

            // ── Record position for repetition detection ──
            _positionHistory.Add(GetPositionKey());

            // ── Build result ──
            result.IsCapture = isCapture;
            result.CapturedPiece = capturedPiece;
            result.IsCastle = isCastle;
            result.IsEnPassant = isEnPassant;
            result.IsPromotion = isPromotion;

            PieceColor opponent = Turn; // after switching, Turn is the opponent
            bool inCheck = IsInCheck(opponent);
            result.IsCheck = inCheck;

            var legalMoves = GetLegalMoves();
            if (legalMoves.Count == 0)
            {
                if (inCheck)
                {
                    result.IsCheckmate = true;
                    result.GameOverReason = (Opposite(opponent)).ToString() + " wins by checkmate";
                }
                else
                {
                    result.IsStalemate = true;
                    result.IsDraw = true;
                    result.GameOverReason = "Draw by stalemate";
                }
            }
            else if (IsInsufficientMaterial())
            {
                result.IsDraw = true;
                result.GameOverReason = "Draw by insufficient material";
            }
            else if (Is50MoveRule())
            {
                result.IsDraw = true;
                result.GameOverReason = "Draw by 50-move rule";
            }
            else if (IsThreefoldRepetition())
            {
                result.IsDraw = true;
                result.GameOverReason = "Draw by threefold repetition";
            }

            return result;
        }

        // ────────────────────────────────────────────────
        // Game state queries
        // ────────────────────────────────────────────────

        public bool IsInCheck(PieceColor color)
        {
            var king = FindKing(color);
            if (king.Row < 0) return false;
            return IsSquareAttacked(king.Row, king.Col, Opposite(color));
        }

        public bool IsCheckmate()
        {
            return IsInCheck(Turn) && GetLegalMoves().Count == 0;
        }

        public bool IsStalemate()
        {
            return !IsInCheck(Turn) && GetLegalMoves().Count == 0;
        }

        public bool IsInsufficientMaterial()
        {
            var whitePieces = new List<Piece>();
            var blackPieces = new List<Piece>();

            for (int r = 0; r < 8; r++)
                for (int c = 0; c < 8; c++)
                {
                    Piece p = _squares[r, c];
                    if (p.IsEmpty) continue;
                    if (p.Color == PieceColor.White) whitePieces.Add(p);
                    else blackPieces.Add(p);
                }

            // K vs K
            if (whitePieces.Count == 1 && blackPieces.Count == 1)
                return true;

            // K+B vs K or K+N vs K
            if (whitePieces.Count == 1 && blackPieces.Count == 2)
            {
                var extra = blackPieces.Find(p => p.Type != PieceType.King);
                if (extra.Type == PieceType.Bishop || extra.Type == PieceType.Knight)
                    return true;
            }
            if (blackPieces.Count == 1 && whitePieces.Count == 2)
            {
                var extra = whitePieces.Find(p => p.Type != PieceType.King);
                if (extra.Type == PieceType.Bishop || extra.Type == PieceType.Knight)
                    return true;
            }

            // K+B vs K+B same color bishops
            if (whitePieces.Count == 2 && blackPieces.Count == 2)
            {
                var wb = whitePieces.Find(p => p.Type != PieceType.King);
                var bb = blackPieces.Find(p => p.Type != PieceType.King);
                if (wb.Type == PieceType.Bishop && bb.Type == PieceType.Bishop)
                {
                    // Find square colors of the bishops
                    (int wr, int wc) = FindPiece(PieceType.Bishop, PieceColor.White);
                    (int br, int bc) = FindPiece(PieceType.Bishop, PieceColor.Black);
                    if ((wr + wc) % 2 == (br + bc) % 2)
                        return true;
                }
            }

            return false;
        }

        private (int Row, int Col) FindPiece(PieceType type, PieceColor color)
        {
            for (int r = 0; r < 8; r++)
                for (int c = 0; c < 8; c++)
                    if (_squares[r, c].Type == type && _squares[r, c].Color == color)
                        return (r, c);
            return (-1, -1);
        }

        public bool Is50MoveRule()
        {
            return HalfmoveClock >= 100; // 100 half-moves = 50 full moves
        }

        public bool IsThreefoldRepetition()
        {
            if (_positionHistory.Count == 0) return false;
            string current = _positionHistory[_positionHistory.Count - 1];
            int count = 0;
            foreach (var key in _positionHistory)
            {
                if (key == current)
                    count++;
                if (count >= 3) return true;
            }
            return false;
        }

        public bool IsGameOver()
        {
            if (IsCheckmate()) return true;
            if (IsStalemate()) return true;
            if (IsInsufficientMaterial()) return true;
            if (Is50MoveRule()) return true;
            if (IsThreefoldRepetition()) return true;
            return false;
        }

        // ────────────────────────────────────────────────
        // Cloning and position keys
        // ────────────────────────────────────────────────

        public ChessBoard Clone()
        {
            ChessBoard copy = new ChessBoard();
            for (int r = 0; r < 8; r++)
                for (int c = 0; c < 8; c++)
                    copy._squares[r, c] = _squares[r, c];

            copy.Turn = Turn;
            copy.WhiteKingSide = WhiteKingSide;
            copy.WhiteQueenSide = WhiteQueenSide;
            copy.BlackKingSide = BlackKingSide;
            copy.BlackQueenSide = BlackQueenSide;
            copy.EnPassantTarget = EnPassantTarget;
            copy.HalfmoveClock = HalfmoveClock;
            copy.FullmoveNumber = FullmoveNumber;
            copy._whiteKingPos = _whiteKingPos;
            copy._blackKingPos = _blackKingPos;
            copy._positionHistory = new List<string>(_positionHistory);
            return copy;
        }

        public string GetPositionKey()
        {
            var sb = new StringBuilder(256);

            for (int r = 0; r < 8; r++)
            {
                int empty = 0;
                for (int c = 0; c < 8; c++)
                {
                    Piece p = _squares[r, c];
                    if (p.IsEmpty)
                    {
                        empty++;
                    }
                    else
                    {
                        if (empty > 0) { sb.Append(empty); empty = 0; }
                        char ch = p.Type switch
                        {
                            PieceType.Pawn   => 'p',
                            PieceType.Knight => 'n',
                            PieceType.Bishop => 'b',
                            PieceType.Rook   => 'r',
                            PieceType.Queen  => 'q',
                            PieceType.King   => 'k',
                            _ => '?'
                        };
                        sb.Append(p.Color == PieceColor.White ? char.ToUpper(ch) : ch);
                    }
                }
                if (empty > 0) sb.Append(empty);
                if (r < 7) sb.Append('/');
            }

            sb.Append(Turn == PieceColor.White ? " w " : " b ");

            bool anyCastle = false;
            if (WhiteKingSide) { sb.Append('K'); anyCastle = true; }
            if (WhiteQueenSide) { sb.Append('Q'); anyCastle = true; }
            if (BlackKingSide) { sb.Append('k'); anyCastle = true; }
            if (BlackQueenSide) { sb.Append('q'); anyCastle = true; }
            if (!anyCastle) sb.Append('-');

            sb.Append(' ');

            if (EnPassantTarget.HasValue)
            {
                sb.Append((char)('a' + EnPassantTarget.Value.Col));
                sb.Append((char)('1' + EnPassantTarget.Value.Row));
            }
            else
            {
                sb.Append('-');
            }

            return sb.ToString();
        }
    }
}
