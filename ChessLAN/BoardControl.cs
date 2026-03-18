using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Linq;
using System.Windows.Forms;

namespace ChessLAN
{
    public class BoardControl : UserControl
    {
        private const int SquareSize = 60;
        private const int BoardPixels = SquareSize * 8;

        private static readonly Color LightSquare = ColorTranslator.FromHtml("#F0D9B5");
        private static readonly Color DarkSquare = ColorTranslator.FromHtml("#B58863");
        private static readonly Color LastMoveHighlight = Color.FromArgb(120, 255, 255, 0);
        private static readonly Color PremoveHighlight = Color.FromArgb(120, 80, 120, 255);
        private static readonly Color CheckHighlight = Color.FromArgb(160, 255, 0, 0);
        private static readonly Color LegalMoveDot = Color.FromArgb(80, 0, 150, 0);
        private static readonly Color LegalMoveRing = Color.FromArgb(80, 0, 150, 0);

        public ChessBoard Board { get; set; } = new ChessBoard();
        public PieceColor MyColor { get; set; } = PieceColor.White;
        public bool IsMyTurn { get; set; }
        public bool AllowPremoves { get; set; } = true;

        public event Action<Move>? MoveMade;
        public event Action<Move>? PremoveMade;

        private (int Row, int Col)? _dragFrom;
        private Point _dragPoint;
        private List<Move>? _legalMoves;
        private Move? _lastMove;
        private Move? _premove;
        private bool _animating;

        // Animation state
        private System.Windows.Forms.Timer? _animTimer;
        private Move _animMove;
        private Piece _animPiece;
        private PointF _animFrom;
        private PointF _animTo;
        private PointF _animCurrent;
        private DateTime _animStart;
        private const int AnimDurationMs = 200;
        private Action? _animOnComplete;

        private Font _pieceFont;

        public BoardControl()
        {
            DoubleBuffered = true;
            Width = BoardPixels;
            Height = BoardPixels;
            _pieceFont = new Font("Segoe UI Symbol", 36f, FontStyle.Regular, GraphicsUnit.Point);
        }

        public void SetLastMove(Move move)
        {
            _lastMove = move;
            Invalidate();
        }

        public void ClearPremove()
        {
            _premove = null;
            Invalidate();
        }

        public Move? GetAndClearPremove()
        {
            var pm = _premove;
            _premove = null;
            Invalidate();
            return pm;
        }

        public void AnimateMove(Move move, Action onComplete)
        {
            _animating = true;
            _animMove = move;
            _animPiece = Board.GetPiece(move.FromRow, move.FromCol);
            _animFrom = GetSquareCenter(move.FromRow, move.FromCol);
            _animTo = GetSquareCenter(move.ToRow, move.ToCol);
            _animCurrent = _animFrom;
            _animStart = DateTime.UtcNow;
            _animOnComplete = onComplete;

            _animTimer?.Dispose();
            _animTimer = new System.Windows.Forms.Timer();
            _animTimer.Interval = 16;
            _animTimer.Tick += AnimTick;
            _animTimer.Start();
            Invalidate();
        }

        private void AnimTick(object? sender, EventArgs e)
        {
            double elapsed = (DateTime.UtcNow - _animStart).TotalMilliseconds;
            float t = Math.Min(1f, (float)(elapsed / AnimDurationMs));

            _animCurrent = new PointF(
                _animFrom.X + (_animTo.X - _animFrom.X) * t,
                _animFrom.Y + (_animTo.Y - _animFrom.Y) * t
            );

            Invalidate();

            if (t >= 1f)
            {
                _animTimer?.Stop();
                _animTimer?.Dispose();
                _animTimer = null;
                _animating = false;
                _animOnComplete?.Invoke();
            }
        }

        private PointF GetSquareCenter(int row, int col)
        {
            int displayCol, displayRow;
            if (MyColor == PieceColor.Black)
            {
                displayCol = 7 - col;
                displayRow = row;
            }
            else
            {
                displayCol = col;
                displayRow = 7 - row;
            }
            return new PointF(displayCol * SquareSize + SquareSize / 2f, displayRow * SquareSize + SquareSize / 2f);
        }

        private (int Row, int Col) DisplayToBoard(int displayRow, int displayCol)
        {
            if (MyColor == PieceColor.Black)
            {
                return (displayRow, 7 - displayCol);
            }
            else
            {
                return (7 - displayRow, displayCol);
            }
        }

        private (int DisplayRow, int DisplayCol) BoardToDisplay(int row, int col)
        {
            if (MyColor == PieceColor.Black)
            {
                return (row, 7 - col);
            }
            else
            {
                return (7 - row, col);
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAlias;

            // Draw board squares
            for (int dr = 0; dr < 8; dr++)
            {
                for (int dc = 0; dc < 8; dc++)
                {
                    bool isLight = (dr + dc) % 2 == 0;
                    Color color = isLight ? LightSquare : DarkSquare;
                    using var brush = new SolidBrush(color);
                    g.FillRectangle(brush, dc * SquareSize, dr * SquareSize, SquareSize, SquareSize);
                }
            }

            // Draw last move highlight
            if (_lastMove.HasValue)
            {
                DrawSquareHighlight(g, _lastMove.Value.FromRow, _lastMove.Value.FromCol, LastMoveHighlight);
                DrawSquareHighlight(g, _lastMove.Value.ToRow, _lastMove.Value.ToCol, LastMoveHighlight);
            }

            // Draw premove highlight
            if (_premove.HasValue)
            {
                DrawSquareHighlight(g, _premove.Value.FromRow, _premove.Value.FromCol, PremoveHighlight);
                DrawSquareHighlight(g, _premove.Value.ToRow, _premove.Value.ToCol, PremoveHighlight);
            }

            // Draw check highlight
            PieceColor turnColor = Board.Turn;
            if (Board.IsInCheck(turnColor))
            {
                for (int r = 0; r < 8; r++)
                    for (int c = 0; c < 8; c++)
                    {
                        var piece = Board.GetPiece(r, c);
                        if (piece.Type == PieceType.King && piece.Color == turnColor)
                        {
                            DrawSquareHighlight(g, r, c, CheckHighlight);
                        }
                    }
            }

            // Draw legal move indicators
            if (_dragFrom.HasValue && _legalMoves != null)
            {
                foreach (var move in _legalMoves)
                {
                    var (dRow, dCol) = BoardToDisplay(move.ToRow, move.ToCol);
                    int cx = dCol * SquareSize + SquareSize / 2;
                    int cy = dRow * SquareSize + SquareSize / 2;

                    bool hasEnemy = !Board.GetPiece(move.ToRow, move.ToCol).IsEmpty;
                    if (hasEnemy)
                    {
                        // Draw ring
                        int ringSize = SquareSize - 8;
                        using var pen = new Pen(LegalMoveRing, 3);
                        g.DrawEllipse(pen, cx - ringSize / 2, cy - ringSize / 2, ringSize, ringSize);
                    }
                    else
                    {
                        // Draw filled circle
                        int dotSize = 16;
                        using var brush = new SolidBrush(LegalMoveDot);
                        g.FillEllipse(brush, cx - dotSize / 2, cy - dotSize / 2, dotSize, dotSize);
                    }
                }
            }

            // Draw pieces
            for (int r = 0; r < 8; r++)
            {
                for (int c = 0; c < 8; c++)
                {
                    // Skip the piece being dragged
                    if (_dragFrom.HasValue && _dragFrom.Value.Row == r && _dragFrom.Value.Col == c)
                        continue;

                    // Skip the piece being animated at its source
                    if (_animating && _animMove.FromRow == r && _animMove.FromCol == c)
                        continue;

                    var piece = Board.GetPiece(r, c);
                    if (!piece.IsEmpty)
                    {
                        var (dRow, dCol) = BoardToDisplay(r, c);
                        DrawPiece(g, piece, dCol * SquareSize, dRow * SquareSize);
                    }
                }
            }

            // Draw animating piece
            if (_animating)
            {
                float x = _animCurrent.X - SquareSize / 2f;
                float y = _animCurrent.Y - SquareSize / 2f;
                DrawPiece(g, _animPiece, x, y);
            }

            // Draw dragged piece on top
            if (_dragFrom.HasValue)
            {
                var piece = Board.GetPiece(_dragFrom.Value.Row, _dragFrom.Value.Col);
                if (!piece.IsEmpty)
                {
                    float x = _dragPoint.X - SquareSize / 2f;
                    float y = _dragPoint.Y - SquareSize / 2f;
                    DrawPiece(g, piece, x, y);
                }
            }

            // Draw file/rank labels
            using var labelFont = new Font("Segoe UI", 9f, FontStyle.Bold);
            for (int i = 0; i < 8; i++)
            {
                var (_, fileDisp) = BoardToDisplay(0, i);
                char fileChar = (char)('a' + i);
                if (MyColor == PieceColor.Black) fileChar = (char)('h' - i);
                else fileChar = (char)('a' + i);

                // Compute actual file label from board col
                int boardCol = MyColor == PieceColor.Black ? 7 - i : i;
                char file = (char)('a' + boardCol);
                Color labelColor = (7 + i) % 2 == 0 ? DarkSquare : LightSquare;
                using var labelBrush = new SolidBrush(labelColor);
                g.DrawString(file.ToString(), labelFont, labelBrush, i * SquareSize + 2, BoardPixels - 14);

                // Rank labels
                int boardRow = MyColor == PieceColor.Black ? i : 7 - i;
                char rank = (char)('1' + boardRow);
                Color rankColor = (i) % 2 == 0 ? DarkSquare : LightSquare;
                using var rankBrush = new SolidBrush(rankColor);
                g.DrawString(rank.ToString(), labelFont, rankBrush, BoardPixels - 12, i * SquareSize + 2);
            }
        }

        private void DrawSquareHighlight(Graphics g, int boardRow, int boardCol, Color color)
        {
            var (dRow, dCol) = BoardToDisplay(boardRow, boardCol);
            using var brush = new SolidBrush(color);
            g.FillRectangle(brush, dCol * SquareSize, dRow * SquareSize, SquareSize, SquareSize);
        }

        private void DrawPiece(Graphics g, Piece piece, float x, float y)
        {
            string ch = GetUnicode(piece);
            if (string.IsNullOrEmpty(ch)) return;

            // Measure to center
            var size = g.MeasureString(ch, _pieceFont);
            float offsetX = (SquareSize - size.Width) / 2f;
            float offsetY = (SquareSize - size.Height) / 2f;
            float px = x + offsetX;
            float py = y + offsetY;

            // Draw outline for visibility
            using var outlineBrush = new SolidBrush(piece.Color == PieceColor.White ? Color.Black : Color.FromArgb(60, 0, 0, 0));
            for (int dx = -1; dx <= 1; dx++)
                for (int dy = -1; dy <= 1; dy++)
                    if (dx != 0 || dy != 0)
                        g.DrawString(ch, _pieceFont, outlineBrush, px + dx, py + dy);

            // Draw the piece
            Color pieceColor = piece.Color == PieceColor.White ? Color.White : Color.FromArgb(50, 50, 50);
            using var pieceBrush = new SolidBrush(pieceColor);
            g.DrawString(ch, _pieceFont, pieceBrush, px, py);
        }

        private static string GetUnicode(Piece piece)
        {
            if (piece.IsEmpty) return "";
            if (piece.Color == PieceColor.White)
            {
                return piece.Type switch
                {
                    PieceType.King => "\u2654",
                    PieceType.Queen => "\u2655",
                    PieceType.Rook => "\u2656",
                    PieceType.Bishop => "\u2657",
                    PieceType.Knight => "\u2658",
                    PieceType.Pawn => "\u2659",
                    _ => ""
                };
            }
            else
            {
                return piece.Type switch
                {
                    PieceType.King => "\u265A",
                    PieceType.Queen => "\u265B",
                    PieceType.Rook => "\u265C",
                    PieceType.Bishop => "\u265D",
                    PieceType.Knight => "\u265E",
                    PieceType.Pawn => "\u265F",
                    _ => ""
                };
            }
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (_animating) return;
            if (e.Button != MouseButtons.Left) return;

            int displayCol = e.X / SquareSize;
            int displayRow = e.Y / SquareSize;
            if (displayCol < 0 || displayCol >= 8 || displayRow < 0 || displayRow >= 8) return;

            var (boardRow, boardCol) = DisplayToBoard(displayRow, displayCol);
            var piece = Board.GetPiece(boardRow, boardCol);

            if (piece.IsEmpty) return;

            // Only allow picking up own pieces (or any piece for premoves when not my turn)
            if (IsMyTurn)
            {
                if (piece.Color != MyColor) return;
                _legalMoves = Board.GetLegalMoves(boardRow, boardCol);
            }
            else if (AllowPremoves)
            {
                if (piece.Color != MyColor) return;
                // For premoves, show all pseudo-legal destinations (we use legal moves from a cloned board with forced turn)
                _legalMoves = GetPremoveCandidates(boardRow, boardCol);
            }
            else
            {
                return;
            }

            _dragFrom = (boardRow, boardCol);
            _dragPoint = e.Location;
            Invalidate();
        }

        private List<Move> GetPremoveCandidates(int row, int col)
        {
            // Create a temporary board with our color's turn to compute legal moves
            var clone = Board.Clone();
            // Force the turn to our color so GetLegalMoves works
            var turnField = typeof(ChessBoard).GetProperty("Turn");
            // Use reflection to set Turn or just compute pseudo-legal manually
            // Simpler: just return all squares we could theoretically move to
            var moves = new List<Move>();
            var piece = Board.GetPiece(row, col);
            if (piece.IsEmpty) return moves;

            // Generate all potential destination squares for this piece type
            // We use a brute-force approach: try all 64 squares as destinations
            for (int r = 0; r < 8; r++)
            {
                for (int c = 0; c < 8; c++)
                {
                    if (r == row && c == col) continue;
                    var target = Board.GetPiece(r, c);
                    if (target.Color == MyColor) continue; // Can't capture own pieces

                    // Basic validation based on piece type
                    bool valid = false;
                    switch (piece.Type)
                    {
                        case PieceType.Pawn:
                            int dir = MyColor == PieceColor.White ? 1 : -1;
                            int startRow = MyColor == PieceColor.White ? 1 : 6;
                            if (c == col && r == row + dir && target.IsEmpty) valid = true;
                            if (c == col && r == row + 2 * dir && row == startRow) valid = true;
                            if (Math.Abs(c - col) == 1 && r == row + dir) valid = true;
                            break;
                        case PieceType.Knight:
                            int dr = Math.Abs(r - row), dc = Math.Abs(c - col);
                            if ((dr == 2 && dc == 1) || (dr == 1 && dc == 2)) valid = true;
                            break;
                        case PieceType.Bishop:
                            if (Math.Abs(r - row) == Math.Abs(c - col)) valid = true;
                            break;
                        case PieceType.Rook:
                            if (r == row || c == col) valid = true;
                            break;
                        case PieceType.Queen:
                            if (r == row || c == col || Math.Abs(r - row) == Math.Abs(c - col)) valid = true;
                            break;
                        case PieceType.King:
                            int ddr = Math.Abs(r - row), ddc = Math.Abs(c - col);
                            if (ddr <= 1 && ddc <= 1) valid = true;
                            // Castling
                            if (ddr == 0 && ddc == 2 && row == r) valid = true;
                            break;
                    }

                    if (valid)
                    {
                        // Check if promotion
                        int promoRow = MyColor == PieceColor.White ? 7 : 0;
                        if (piece.Type == PieceType.Pawn && r == promoRow)
                        {
                            moves.Add(new Move { FromRow = row, FromCol = col, ToRow = r, ToCol = c, Promotion = PieceType.Queen });
                        }
                        else
                        {
                            moves.Add(new Move { FromRow = row, FromCol = col, ToRow = r, ToCol = c, Promotion = PieceType.None });
                        }
                    }
                }
            }
            return moves;
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (_dragFrom.HasValue)
            {
                _dragPoint = e.Location;
                Invalidate();
            }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (!_dragFrom.HasValue) return;

            int displayCol = e.X / SquareSize;
            int displayRow = e.Y / SquareSize;

            _dragFrom = null;

            if (displayCol < 0 || displayCol >= 8 || displayRow < 0 || displayRow >= 8)
            {
                _legalMoves = null;
                Invalidate();
                return;
            }

            var (toRow, toCol) = DisplayToBoard(displayRow, displayCol);

            if (_legalMoves == null)
            {
                Invalidate();
                return;
            }

            // Find matching move
            var matchingMoves = _legalMoves.Where(m => m.ToRow == toRow && m.ToCol == toCol).ToList();
            _legalMoves = null;

            if (matchingMoves.Count == 0)
            {
                Invalidate();
                return;
            }

            Move selectedMove;
            if (matchingMoves.Count > 1 && matchingMoves.Any(m => m.Promotion != PieceType.None))
            {
                // Promotion - ask user
                var promoType = ShowPromotionDialog();
                var found = matchingMoves.FirstOrDefault(m => m.Promotion == promoType);
                if (found.Promotion == PieceType.None && promoType != PieceType.None)
                {
                    Invalidate();
                    return;
                }
                selectedMove = found;
            }
            else
            {
                selectedMove = matchingMoves[0];
            }

            if (IsMyTurn)
            {
                MoveMade?.Invoke(selectedMove);
            }
            else if (AllowPremoves)
            {
                _premove = selectedMove;
                PremoveMade?.Invoke(selectedMove);
            }

            Invalidate();
        }

        private PieceType ShowPromotionDialog()
        {
            using var dialog = new Form();
            dialog.Text = "Promote Pawn";
            dialog.FormBorderStyle = FormBorderStyle.FixedDialog;
            dialog.StartPosition = FormStartPosition.CenterParent;
            dialog.Size = new Size(280, 100);
            dialog.MinimizeBox = false;
            dialog.MaximizeBox = false;

            PieceType result = PieceType.Queen;

            string[] labels = { "Queen", "Rook", "Bishop", "Knight" };
            PieceType[] types = { PieceType.Queen, PieceType.Rook, PieceType.Bishop, PieceType.Knight };

            for (int i = 0; i < 4; i++)
            {
                var btn = new Button();
                btn.Text = labels[i];
                btn.Location = new Point(10 + i * 65, 15);
                btn.Size = new Size(60, 35);
                int idx = i;
                btn.Click += (s, e) =>
                {
                    result = types[idx];
                    dialog.DialogResult = DialogResult.OK;
                    dialog.Close();
                };
                dialog.Controls.Add(btn);
            }

            dialog.ShowDialog(this.FindForm());
            return result;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _animTimer?.Stop();
                _animTimer?.Dispose();
                _pieceFont?.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
