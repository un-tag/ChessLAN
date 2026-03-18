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
        private int SquareSize => Math.Max(1, Width / 8);

        // Chess.com default green theme
        private static readonly Color LightSquare = ColorTranslator.FromHtml("#EEEED2");
        private static readonly Color DarkSquare = ColorTranslator.FromHtml("#769656");
        private static readonly Color LastMoveLight = ColorTranslator.FromHtml("#F6F669");
        private static readonly Color LastMoveDark = ColorTranslator.FromHtml("#BACA2B");
        private static readonly Color SelectedLight = ColorTranslator.FromHtml("#F6F669");
        private static readonly Color SelectedDark = ColorTranslator.FromHtml("#BACA2B");
        private static readonly Color PremoveLight = Color.FromArgb(130, 100, 140, 255);
        private static readonly Color PremoveDark = Color.FromArgb(130, 70, 110, 230);
        private static readonly Color CheckHighlight = Color.FromArgb(200, 235, 50, 50);
        private static readonly Color LegalMoveDot = Color.FromArgb(60, 0, 0, 0);
        private static readonly Color LegalMoveCapture = Color.FromArgb(60, 0, 0, 0);

        public ChessBoard Board { get; set; } = new ChessBoard();
        public PieceColor MyColor { get; set; } = PieceColor.White;
        public bool IsMyTurn { get; set; }
        public bool AllowPremoves { get; set; } = true;
        public bool ShowLegalMoves { get; set; } = true;

        public event Action<Move>? MoveMade;
        public event Action<Move>? PremoveMade;

        private (int Row, int Col)? _dragFrom;
        private (int Row, int Col)? _selectedSquare;
        private Point _dragPoint;
        private bool _isDragging;
        private Point _mouseDownPoint;
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
        private const int AnimDurationMs = 150;
        private Action? _animOnComplete;

        private Font _pieceFont;
        private Font _coordFont;

        public BoardControl()
        {
            DoubleBuffered = true;
            _pieceFont = new Font("Segoe UI Symbol", 36f, FontStyle.Regular, GraphicsUnit.Point);
            _coordFont = new Font("Segoe UI", 9f, FontStyle.Bold);
            Resize += (s, e) => UpdateFonts();
        }

        private void UpdateFonts()
        {
            _pieceFont?.Dispose();
            _coordFont?.Dispose();
            float fontSize = Math.Max(8f, SquareSize * 0.58f);
            float coordSize = Math.Max(6f, SquareSize * 0.14f);
            _pieceFont = new Font("Segoe UI Symbol", fontSize, FontStyle.Regular, GraphicsUnit.Point);
            _coordFont = new Font("Segoe UI", coordSize, FontStyle.Bold);
            Invalidate();
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
            // Ease out
            t = 1f - (1f - t) * (1f - t);

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
                return (displayRow, 7 - displayCol);
            else
                return (7 - displayRow, displayCol);
        }

        private (int DisplayRow, int DisplayCol) BoardToDisplay(int row, int col)
        {
            if (MyColor == PieceColor.Black)
                return (row, 7 - col);
            else
                return (7 - row, col);
        }

        private bool IsLightSquare(int displayRow, int displayCol) => (displayRow + displayCol) % 2 == 0;

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAlias;
            int sq = SquareSize;

            // Draw board squares
            for (int dr = 0; dr < 8; dr++)
            {
                for (int dc = 0; dc < 8; dc++)
                {
                    bool light = IsLightSquare(dr, dc);
                    Color color = light ? LightSquare : DarkSquare;
                    using var brush = new SolidBrush(color);
                    g.FillRectangle(brush, dc * sq, dr * sq, sq, sq);
                }
            }

            // Draw last move highlight
            if (_lastMove.HasValue)
            {
                DrawSquareColor(g, _lastMove.Value.FromRow, _lastMove.Value.FromCol);
                DrawSquareColor(g, _lastMove.Value.ToRow, _lastMove.Value.ToCol);
            }

            // Draw selected square highlight
            if (_selectedSquare.HasValue && !_isDragging)
            {
                DrawSquareColor(g, _selectedSquare.Value.Row, _selectedSquare.Value.Col);
            }

            // Draw premove highlight
            if (_premove.HasValue)
            {
                var (dr1, dc1) = BoardToDisplay(_premove.Value.FromRow, _premove.Value.FromCol);
                var (dr2, dc2) = BoardToDisplay(_premove.Value.ToRow, _premove.Value.ToCol);
                bool l1 = IsLightSquare(dr1, dc1), l2 = IsLightSquare(dr2, dc2);
                using var b1 = new SolidBrush(l1 ? PremoveLight : PremoveDark);
                using var b2 = new SolidBrush(l2 ? PremoveLight : PremoveDark);
                g.FillRectangle(b1, dc1 * sq, dr1 * sq, sq, sq);
                g.FillRectangle(b2, dc2 * sq, dr2 * sq, sq, sq);
            }

            // Draw check highlight (radial gradient on king square)
            PieceColor turnColor = Board.Turn;
            if (Board.IsInCheck(turnColor))
            {
                for (int r = 0; r < 8; r++)
                    for (int c = 0; c < 8; c++)
                    {
                        var piece = Board.GetPiece(r, c);
                        if (piece.Type == PieceType.King && piece.Color == turnColor)
                        {
                            var (dRow, dCol) = BoardToDisplay(r, c);
                            int cx = dCol * sq + sq / 2;
                            int cy = dRow * sq + sq / 2;
                            using var path = new GraphicsPath();
                            path.AddEllipse(cx - sq / 2, cy - sq / 2, sq, sq);
                            using var pgb = new PathGradientBrush(path);
                            pgb.CenterColor = Color.FromArgb(220, 255, 0, 0);
                            pgb.SurroundColors = new[] { Color.FromArgb(60, 255, 0, 0) };
                            g.FillRectangle(new SolidBrush(CheckHighlight), dCol * sq, dRow * sq, sq, sq);
                        }
                    }
            }

            // Draw coordinates (chess.com style: file letters on bottom edge, rank numbers on left edge)
            for (int i = 0; i < 8; i++)
            {
                // File labels (bottom of each column, inside the square)
                int boardCol = MyColor == PieceColor.Black ? 7 - i : i;
                char file = (char)('a' + boardCol);
                bool bottomLight = IsLightSquare(7, i);
                using var fileBrush = new SolidBrush(bottomLight ? DarkSquare : LightSquare);
                g.DrawString(file.ToString(), _coordFont, fileBrush,
                    i * sq + 2, 7 * sq + sq - _coordFont.GetHeight(g) - 1);

                // Rank labels (top of each row on left edge, inside the square)
                int boardRow = MyColor == PieceColor.Black ? i : 7 - i;
                char rank = (char)('1' + boardRow);
                bool leftLight = IsLightSquare(i, 0);
                using var rankBrush = new SolidBrush(leftLight ? DarkSquare : LightSquare);
                g.DrawString(rank.ToString(), _coordFont, rankBrush, 2, i * sq + 1);
            }

            // Draw legal move indicators
            if (ShowLegalMoves && (_dragFrom.HasValue || _selectedSquare.HasValue) && _legalMoves != null)
            {
                foreach (var move in _legalMoves)
                {
                    var (dRow, dCol) = BoardToDisplay(move.ToRow, move.ToCol);
                    int cx = dCol * sq + sq / 2;
                    int cy = dRow * sq + sq / 2;

                    bool hasEnemy = !Board.GetPiece(move.ToRow, move.ToCol).IsEmpty;
                    if (hasEnemy)
                    {
                        // Chess.com style: large transparent ring over the piece
                        int ringOuter = (int)(sq * 0.9);
                        int ringInner = (int)(sq * 0.7);
                        using var outerPath = new GraphicsPath();
                        outerPath.AddEllipse(cx - ringOuter / 2, cy - ringOuter / 2, ringOuter, ringOuter);
                        using var innerPath = new GraphicsPath();
                        innerPath.AddEllipse(cx - ringInner / 2, cy - ringInner / 2, ringInner, ringInner);
                        using var region = new Region(outerPath);
                        region.Exclude(innerPath);
                        using var brush = new SolidBrush(LegalMoveCapture);
                        g.FillRegion(brush, region);
                    }
                    else
                    {
                        // Chess.com style: small centered dot
                        int dotSize = (int)(sq * 0.3);
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
                    if (_isDragging && _dragFrom.HasValue && _dragFrom.Value.Row == r && _dragFrom.Value.Col == c)
                        continue;
                    if (_animating && _animMove.FromRow == r && _animMove.FromCol == c)
                        continue;

                    var piece = Board.GetPiece(r, c);
                    if (!piece.IsEmpty)
                    {
                        var (dRow, dCol) = BoardToDisplay(r, c);
                        DrawPiece(g, piece, dCol * sq, dRow * sq);
                    }
                }
            }

            // Draw animating piece
            if (_animating)
            {
                float x = _animCurrent.X - sq / 2f;
                float y = _animCurrent.Y - sq / 2f;
                DrawPiece(g, _animPiece, x, y);
            }

            // Draw dragged piece on top (slightly larger for feedback)
            if (_dragFrom.HasValue && _isDragging)
            {
                var piece = Board.GetPiece(_dragFrom.Value.Row, _dragFrom.Value.Col);
                if (!piece.IsEmpty)
                {
                    float x = _dragPoint.X - sq / 2f;
                    float y = _dragPoint.Y - sq / 2f;
                    DrawPiece(g, piece, x, y, dragging: true);
                }
            }
        }

        private void DrawSquareColor(Graphics g, int boardRow, int boardCol)
        {
            var (dRow, dCol) = BoardToDisplay(boardRow, boardCol);
            bool light = IsLightSquare(dRow, dCol);
            Color color = light ? LastMoveLight : LastMoveDark;
            using var brush = new SolidBrush(color);
            g.FillRectangle(brush, dCol * SquareSize, dRow * SquareSize, SquareSize, SquareSize);
        }

        private void DrawPiece(Graphics g, Piece piece, float x, float y, bool dragging = false)
        {
            // Use filled Unicode pieces for both colors (chess.com style)
            string ch = GetFilledUnicode(piece.Type);
            if (string.IsNullOrEmpty(ch)) return;

            int sq = SquareSize;
            float scale = dragging ? 1.15f : 1f;
            float effectiveSize = sq * scale;
            float offset = (sq - effectiveSize) / 2f;

            // Measure and center
            var size = g.MeasureString(ch, _pieceFont);
            float offsetX = (effectiveSize - size.Width) / 2f;
            float offsetY = (effectiveSize - size.Height) / 2f;
            float px = x + offset + offsetX;
            float py = y + offset + offsetY;

            if (dragging)
            {
                // Recenter on cursor
                px = x + (sq - size.Width) / 2f;
                py = y + (sq - size.Height) / 2f - sq * 0.08f; // Slight upward offset
            }

            if (piece.Color == PieceColor.White)
            {
                // White pieces: dark outline, white fill
                // Draw dark shadow/outline
                using var outlineBrush = new SolidBrush(Color.FromArgb(40, 40, 40));
                float outlineW = Math.Max(1f, sq * 0.02f);
                for (float dx = -outlineW; dx <= outlineW; dx += outlineW)
                    for (float dy = -outlineW; dy <= outlineW; dy += outlineW)
                        if (dx != 0 || dy != 0)
                            g.DrawString(ch, _pieceFont, outlineBrush, px + dx, py + dy);

                // White fill
                using var fillBrush = new SolidBrush(Color.FromArgb(255, 255, 255));
                g.DrawString(ch, _pieceFont, fillBrush, px, py);
            }
            else
            {
                // Black pieces: lighter outline for contrast, dark fill
                using var outlineBrush = new SolidBrush(Color.FromArgb(180, 180, 180));
                float outlineW = Math.Max(1f, sq * 0.02f);
                for (float dx = -outlineW; dx <= outlineW; dx += outlineW)
                    for (float dy = -outlineW; dy <= outlineW; dy += outlineW)
                        if (dx != 0 || dy != 0)
                            g.DrawString(ch, _pieceFont, outlineBrush, px + dx, py + dy);

                // Dark fill
                using var fillBrush = new SolidBrush(Color.FromArgb(30, 30, 30));
                g.DrawString(ch, _pieceFont, fillBrush, px, py);
            }
        }

        // Use FILLED Unicode pieces for both colors (like chess.com's clean style)
        private static string GetFilledUnicode(PieceType type)
        {
            return type switch
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

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (_animating) return;
            if (e.Button != MouseButtons.Left) return;

            int sq = SquareSize;
            int displayCol = e.X / sq;
            int displayRow = e.Y / sq;
            if (displayCol < 0 || displayCol >= 8 || displayRow < 0 || displayRow >= 8) return;

            var (boardRow, boardCol) = DisplayToBoard(displayRow, displayCol);
            var piece = Board.GetPiece(boardRow, boardCol);

            // If we already have a selected piece, try to move there
            if (_selectedSquare.HasValue && _legalMoves != null)
            {
                var from = _selectedSquare.Value;

                if (from.Row == boardRow && from.Col == boardCol)
                {
                    _selectedSquare = null;
                    _legalMoves = null;
                    Invalidate();
                    return;
                }

                var matchingMoves = _legalMoves.Where(m => m.ToRow == boardRow && m.ToCol == boardCol).ToList();
                if (matchingMoves.Count > 0)
                {
                    _selectedSquare = null;
                    ExecuteMove(matchingMoves);
                    return;
                }

                if (!piece.IsEmpty && piece.Color == MyColor)
                {
                    _selectedSquare = (boardRow, boardCol);
                    _legalMoves = IsMyTurn ? Board.GetLegalMoves(boardRow, boardCol)
                                           : (AllowPremoves ? GetPremoveCandidates(boardRow, boardCol) : null);
                    _dragFrom = (boardRow, boardCol);
                    _isDragging = false;
                    _mouseDownPoint = e.Location;
                    _dragPoint = e.Location;
                    Invalidate();
                    return;
                }

                _selectedSquare = null;
                _legalMoves = null;
                Invalidate();
                return;
            }

            if (piece.IsEmpty) return;

            if (IsMyTurn)
            {
                if (piece.Color != MyColor) return;
                _legalMoves = Board.GetLegalMoves(boardRow, boardCol);
            }
            else if (AllowPremoves)
            {
                if (piece.Color != MyColor) return;
                _legalMoves = GetPremoveCandidates(boardRow, boardCol);
            }
            else
            {
                return;
            }

            _selectedSquare = (boardRow, boardCol);
            _dragFrom = (boardRow, boardCol);
            _isDragging = false;
            _mouseDownPoint = e.Location;
            _dragPoint = e.Location;
            Invalidate();
        }

        private List<Move> GetPremoveCandidates(int row, int col)
        {
            var moves = new List<Move>();
            var piece = Board.GetPiece(row, col);
            if (piece.IsEmpty) return moves;

            for (int r = 0; r < 8; r++)
            {
                for (int c = 0; c < 8; c++)
                {
                    if (r == row && c == col) continue;
                    var target = Board.GetPiece(r, c);
                    if (target.Color == MyColor) continue;

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
                            if (ddr == 0 && ddc == 2 && row == r) valid = true;
                            break;
                    }

                    if (valid)
                    {
                        int promoRow = MyColor == PieceColor.White ? 7 : 0;
                        if (piece.Type == PieceType.Pawn && r == promoRow)
                            moves.Add(new Move { FromRow = row, FromCol = col, ToRow = r, ToCol = c, Promotion = PieceType.Queen });
                        else
                            moves.Add(new Move { FromRow = row, FromCol = col, ToRow = r, ToCol = c, Promotion = PieceType.None });
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
                if (!_isDragging)
                {
                    int dx = Math.Abs(e.X - _mouseDownPoint.X);
                    int dy = Math.Abs(e.Y - _mouseDownPoint.Y);
                    if (dx > 5 || dy > 5)
                        _isDragging = true;
                    else
                        return;
                }
                _dragPoint = e.Location;
                Invalidate();
            }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (!_dragFrom.HasValue) return;

            if (!_isDragging)
            {
                _dragFrom = null;
                Invalidate();
                return;
            }

            int sq = SquareSize;
            int displayCol = e.X / sq;
            int displayRow = e.Y / sq;

            _dragFrom = null;
            _selectedSquare = null;
            _isDragging = false;

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

            var matchingMoves = _legalMoves.Where(m => m.ToRow == toRow && m.ToCol == toCol).ToList();
            _legalMoves = null;

            if (matchingMoves.Count == 0)
            {
                Invalidate();
                return;
            }

            ExecuteMove(matchingMoves);
        }

        private void ExecuteMove(List<Move> matchingMoves)
        {
            Move selectedMove;
            if (matchingMoves.Count > 1 && matchingMoves.Any(m => m.Promotion != PieceType.None))
            {
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

            _legalMoves = null;
            _selectedSquare = null;

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
            dialog.Text = "Promote";
            dialog.FormBorderStyle = FormBorderStyle.FixedDialog;
            dialog.StartPosition = FormStartPosition.CenterParent;
            dialog.BackColor = Color.FromArgb(50, 50, 50);
            dialog.Size = new Size(300, 90);
            dialog.MinimizeBox = false;
            dialog.MaximizeBox = false;

            PieceType result = PieceType.Queen;
            string[] labels = { "\u265B", "\u265C", "\u265D", "\u265E" };
            PieceType[] types = { PieceType.Queen, PieceType.Rook, PieceType.Bishop, PieceType.Knight };

            for (int i = 0; i < 4; i++)
            {
                var btn = new Button();
                btn.Text = labels[i];
                btn.Font = new Font("Segoe UI Symbol", 22f);
                btn.Location = new Point(10 + i * 70, 5);
                btn.Size = new Size(60, 45);
                btn.FlatStyle = FlatStyle.Flat;
                btn.BackColor = Color.FromArgb(80, 80, 80);
                btn.ForeColor = Color.White;
                btn.FlatAppearance.BorderSize = 0;
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
                _coordFont?.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
