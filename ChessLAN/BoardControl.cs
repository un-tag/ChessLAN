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

        private Font _coordFont;

        public BoardControl()
        {
            DoubleBuffered = true;
            _coordFont = new Font("Segoe UI", 9f, FontStyle.Bold);
            Resize += (s, e) => UpdateCoordFont();
        }

        private void UpdateCoordFont()
        {
            _coordFont?.Dispose();
            float coordSize = Math.Max(6f, SquareSize * 0.14f);
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

        // ─── GDI+ Vector Piece Drawing ─────────────────────────────────

        private void DrawPiece(Graphics g, Piece piece, float x, float y, bool dragging = false)
        {
            int sq = SquareSize;
            float scale = dragging ? 1.1f : 1f;
            float margin = sq * 0.08f;
            float size = (sq - margin * 2) * scale;
            float offsetX = x + (sq - size) / 2f;
            float offsetY = y + (sq - size) / 2f;
            if (dragging) offsetY -= sq * 0.05f;

            using var path = GetPiecePath(piece.Type, offsetX, offsetY, size);
            if (path == null) return;

            // Draw shadow
            using var shadowBrush = new SolidBrush(Color.FromArgb(40, 0, 0, 0));
            var savedTransform = g.Transform;
            g.TranslateTransform(1.5f, 1.5f);
            g.FillPath(shadowBrush, path);
            g.Transform = savedTransform;

            // Fill
            Color fill = piece.Color == PieceColor.White
                ? Color.FromArgb(255, 255, 255)
                : Color.FromArgb(64, 48, 48);
            using var fillBrush = new SolidBrush(fill);
            g.FillPath(fillBrush, path);

            // Outline
            Color outline = piece.Color == PieceColor.White
                ? Color.FromArgb(51, 51, 51)
                : Color.FromArgb(26, 26, 26);
            float strokeW = Math.Max(1f, sq / 40f);
            using var pen = new Pen(outline, strokeW);
            pen.LineJoin = LineJoin.Round;
            g.DrawPath(pen, path);

            // For white pieces draw a subtle inner highlight on certain pieces
            // For black pieces draw a subtle lighter edge along the top
            if (piece.Color == PieceColor.Black)
            {
                using var edgePen = new Pen(Color.FromArgb(30, 200, 200, 200), Math.Max(0.5f, sq / 80f));
                edgePen.LineJoin = LineJoin.Round;
                g.DrawPath(edgePen, path);
            }
        }

        private GraphicsPath? GetPiecePath(PieceType type, float x, float y, float size)
        {
            return type switch
            {
                PieceType.Pawn => BuildPawnPath(x, y, size),
                PieceType.Rook => BuildRookPath(x, y, size),
                PieceType.Knight => BuildKnightPath(x, y, size),
                PieceType.Bishop => BuildBishopPath(x, y, size),
                PieceType.Queen => BuildQueenPath(x, y, size),
                PieceType.King => BuildKingPath(x, y, size),
                _ => null
            };
        }

        // Helper: convert normalized (0-1) coordinates to actual pixel coordinates
        private PointF P(float nx, float ny, float x, float y, float size)
        {
            return new PointF(x + nx * size, y + ny * size);
        }

        private GraphicsPath BuildPawnPath(float x, float y, float size)
        {
            var path = new GraphicsPath();

            // Head (circle)
            float headCx = 0.50f, headCy = 0.26f, headR = 0.14f;
            path.AddEllipse(
                x + (headCx - headR) * size, y + (headCy - headR) * size,
                headR * 2 * size, headR * 2 * size);

            // Neck + body + base as a single polygon shape
            var body = new GraphicsPath();
            body.AddLine(P(0.40f, 0.38f, x, y, size), P(0.60f, 0.38f, x, y, size));
            body.AddLine(P(0.60f, 0.38f, x, y, size), P(0.65f, 0.50f, x, y, size));
            body.AddLine(P(0.65f, 0.50f, x, y, size), P(0.68f, 0.70f, x, y, size));
            body.AddLine(P(0.68f, 0.70f, x, y, size), P(0.72f, 0.74f, x, y, size));
            body.AddLine(P(0.72f, 0.74f, x, y, size), P(0.78f, 0.74f, x, y, size));
            body.AddLine(P(0.78f, 0.74f, x, y, size), P(0.80f, 0.78f, x, y, size));
            body.AddLine(P(0.80f, 0.78f, x, y, size), P(0.80f, 0.86f, x, y, size));
            body.AddLine(P(0.80f, 0.86f, x, y, size), P(0.20f, 0.86f, x, y, size));
            body.AddLine(P(0.20f, 0.86f, x, y, size), P(0.20f, 0.78f, x, y, size));
            body.AddLine(P(0.20f, 0.78f, x, y, size), P(0.22f, 0.74f, x, y, size));
            body.AddLine(P(0.22f, 0.74f, x, y, size), P(0.28f, 0.74f, x, y, size));
            body.AddLine(P(0.28f, 0.74f, x, y, size), P(0.32f, 0.70f, x, y, size));
            body.AddLine(P(0.32f, 0.70f, x, y, size), P(0.35f, 0.50f, x, y, size));
            body.AddLine(P(0.35f, 0.50f, x, y, size), P(0.40f, 0.38f, x, y, size));
            body.CloseFigure();

            path.AddPath(body, false);
            return path;
        }

        private GraphicsPath BuildRookPath(float x, float y, float size)
        {
            var path = new GraphicsPath();

            // Rook outline as a single closed polygon
            var points = new PointF[]
            {
                // Left battlement
                P(0.18f, 0.12f, x, y, size),
                P(0.30f, 0.12f, x, y, size),
                P(0.30f, 0.22f, x, y, size),
                // Gap
                P(0.38f, 0.22f, x, y, size),
                P(0.38f, 0.12f, x, y, size),
                // Middle battlement
                P(0.62f, 0.12f, x, y, size),
                P(0.62f, 0.22f, x, y, size),
                // Gap
                P(0.70f, 0.22f, x, y, size),
                P(0.70f, 0.12f, x, y, size),
                // Right battlement
                P(0.82f, 0.12f, x, y, size),
                P(0.82f, 0.28f, x, y, size),
                // Top band right
                P(0.78f, 0.32f, x, y, size),
                // Body right (slight taper outward going down)
                P(0.74f, 0.36f, x, y, size),
                P(0.72f, 0.68f, x, y, size),
                // Bottom band right
                P(0.78f, 0.72f, x, y, size),
                P(0.84f, 0.76f, x, y, size),
                P(0.84f, 0.88f, x, y, size),
                // Base bottom
                P(0.16f, 0.88f, x, y, size),
                // Bottom band left
                P(0.16f, 0.76f, x, y, size),
                P(0.22f, 0.72f, x, y, size),
                // Body left
                P(0.28f, 0.68f, x, y, size),
                P(0.26f, 0.36f, x, y, size),
                // Top band left
                P(0.22f, 0.32f, x, y, size),
                P(0.18f, 0.28f, x, y, size),
            };

            path.AddPolygon(points);
            return path;
        }

        private GraphicsPath BuildKnightPath(float x, float y, float size)
        {
            var path = new GraphicsPath();

            // Horse head profile facing right, built with bezier curves
            path.StartFigure();

            // Start at base left
            PointF start = P(0.20f, 0.88f, x, y, size);
            path.AddLine(start, P(0.80f, 0.88f, x, y, size));
            // Base right up to bottom of neck
            path.AddLine(P(0.80f, 0.88f, x, y, size), P(0.80f, 0.78f, x, y, size));
            path.AddLine(P(0.80f, 0.78f, x, y, size), P(0.72f, 0.74f, x, y, size));
            path.AddLine(P(0.72f, 0.74f, x, y, size), P(0.68f, 0.60f, x, y, size));

            // Nose / muzzle area
            path.AddBezier(
                P(0.68f, 0.60f, x, y, size),
                P(0.80f, 0.48f, x, y, size),
                P(0.82f, 0.38f, x, y, size),
                P(0.74f, 0.34f, x, y, size));

            // Mouth indent
            path.AddLine(P(0.74f, 0.34f, x, y, size), P(0.68f, 0.38f, x, y, size));

            // Chin to forehead curve
            path.AddBezier(
                P(0.68f, 0.38f, x, y, size),
                P(0.72f, 0.30f, x, y, size),
                P(0.70f, 0.22f, x, y, size),
                P(0.62f, 0.16f, x, y, size));

            // Ear (triangle spike)
            path.AddLine(P(0.62f, 0.16f, x, y, size), P(0.56f, 0.06f, x, y, size));
            path.AddLine(P(0.56f, 0.06f, x, y, size), P(0.48f, 0.18f, x, y, size));

            // Back of head down the neck
            path.AddBezier(
                P(0.48f, 0.18f, x, y, size),
                P(0.40f, 0.24f, x, y, size),
                P(0.34f, 0.34f, x, y, size),
                P(0.30f, 0.46f, x, y, size));

            // Down the back
            path.AddBezier(
                P(0.30f, 0.46f, x, y, size),
                P(0.26f, 0.56f, x, y, size),
                P(0.24f, 0.66f, x, y, size),
                P(0.28f, 0.74f, x, y, size));

            path.AddLine(P(0.28f, 0.74f, x, y, size), P(0.20f, 0.78f, x, y, size));
            path.AddLine(P(0.20f, 0.78f, x, y, size), P(0.20f, 0.88f, x, y, size));

            path.CloseFigure();

            // Eye (small filled circle) - we add it as a separate figure
            float eyeCx = 0.60f, eyeCy = 0.28f, eyeR = 0.030f;
            path.AddEllipse(
                x + (eyeCx - eyeR) * size, y + (eyeCy - eyeR) * size,
                eyeR * 2 * size, eyeR * 2 * size);

            return path;
        }

        private GraphicsPath BuildBishopPath(float x, float y, float size)
        {
            var path = new GraphicsPath();

            // Ball at top
            float ballCx = 0.50f, ballCy = 0.10f, ballR = 0.055f;
            path.AddEllipse(
                x + (ballCx - ballR) * size, y + (ballCy - ballR) * size,
                ballR * 2 * size, ballR * 2 * size);

            // Mitre / hat shape using beziers for a nice pointed shape
            var mitre = new GraphicsPath();
            mitre.StartFigure();
            // Tip
            PointF tip = P(0.50f, 0.15f, x, y, size);
            mitre.AddLine(tip, tip); // start point
            // Right side of hat
            mitre.AddBezier(
                P(0.50f, 0.15f, x, y, size),
                P(0.58f, 0.28f, x, y, size),
                P(0.66f, 0.40f, x, y, size),
                P(0.66f, 0.52f, x, y, size));
            // Collar right
            mitre.AddLine(P(0.66f, 0.52f, x, y, size), P(0.68f, 0.58f, x, y, size));
            mitre.AddLine(P(0.68f, 0.58f, x, y, size), P(0.64f, 0.62f, x, y, size));
            // Body taper down right
            mitre.AddLine(P(0.64f, 0.62f, x, y, size), P(0.66f, 0.72f, x, y, size));
            // Base platform right
            mitre.AddLine(P(0.66f, 0.72f, x, y, size), P(0.76f, 0.76f, x, y, size));
            mitre.AddLine(P(0.76f, 0.76f, x, y, size), P(0.80f, 0.80f, x, y, size));
            mitre.AddLine(P(0.80f, 0.80f, x, y, size), P(0.80f, 0.88f, x, y, size));
            // Base bottom
            mitre.AddLine(P(0.80f, 0.88f, x, y, size), P(0.20f, 0.88f, x, y, size));
            // Base platform left
            mitre.AddLine(P(0.20f, 0.88f, x, y, size), P(0.20f, 0.80f, x, y, size));
            mitre.AddLine(P(0.20f, 0.80f, x, y, size), P(0.24f, 0.76f, x, y, size));
            mitre.AddLine(P(0.24f, 0.76f, x, y, size), P(0.34f, 0.72f, x, y, size));
            // Body taper down left
            mitre.AddLine(P(0.34f, 0.72f, x, y, size), P(0.36f, 0.62f, x, y, size));
            // Collar left
            mitre.AddLine(P(0.36f, 0.62f, x, y, size), P(0.32f, 0.58f, x, y, size));
            mitre.AddLine(P(0.32f, 0.58f, x, y, size), P(0.34f, 0.52f, x, y, size));
            // Left side of hat
            mitre.AddBezier(
                P(0.34f, 0.52f, x, y, size),
                P(0.34f, 0.40f, x, y, size),
                P(0.42f, 0.28f, x, y, size),
                P(0.50f, 0.15f, x, y, size));
            mitre.CloseFigure();
            path.AddPath(mitre, false);

            // Diagonal slit across mitre (drawn as a thin angled rectangle)
            var slit = new GraphicsPath();
            float slitW = 0.018f;
            slit.AddPolygon(new PointF[]
            {
                P(0.38f, 0.42f - slitW, x, y, size),
                P(0.58f, 0.26f - slitW, x, y, size),
                P(0.58f, 0.26f + slitW, x, y, size),
                P(0.38f, 0.42f + slitW, x, y, size),
            });
            path.AddPath(slit, false);

            return path;
        }

        private GraphicsPath BuildQueenPath(float x, float y, float size)
        {
            var path = new GraphicsPath();

            // Five spike tips with small balls
            float[] spikeTipsX = { 0.14f, 0.28f, 0.50f, 0.72f, 0.86f };
            float[] spikeTipsY = { 0.22f, 0.10f, 0.04f, 0.10f, 0.22f };
            float ballR = 0.040f;

            for (int i = 0; i < 5; i++)
            {
                path.AddEllipse(
                    x + (spikeTipsX[i] - ballR) * size, y + (spikeTipsY[i] - ballR) * size,
                    ballR * 2 * size, ballR * 2 * size);
            }

            // Crown + body as one polygon
            var crown = new GraphicsPath();
            crown.StartFigure();

            // Build the crown outline: go across the spikes from left to right
            // then down the body
            crown.AddLine(P(0.14f, 0.26f, x, y, size), P(0.20f, 0.36f, x, y, size));
            crown.AddLine(P(0.20f, 0.36f, x, y, size), P(0.28f, 0.14f, x, y, size));
            crown.AddLine(P(0.28f, 0.14f, x, y, size), P(0.36f, 0.34f, x, y, size));
            crown.AddLine(P(0.36f, 0.34f, x, y, size), P(0.50f, 0.08f, x, y, size));
            crown.AddLine(P(0.50f, 0.08f, x, y, size), P(0.64f, 0.34f, x, y, size));
            crown.AddLine(P(0.64f, 0.34f, x, y, size), P(0.72f, 0.14f, x, y, size));
            crown.AddLine(P(0.72f, 0.14f, x, y, size), P(0.80f, 0.36f, x, y, size));
            crown.AddLine(P(0.80f, 0.36f, x, y, size), P(0.86f, 0.26f, x, y, size));

            // Right side down
            crown.AddLine(P(0.86f, 0.26f, x, y, size), P(0.78f, 0.46f, x, y, size));
            // Crown band
            crown.AddLine(P(0.78f, 0.46f, x, y, size), P(0.74f, 0.50f, x, y, size));
            // Body right
            crown.AddLine(P(0.74f, 0.50f, x, y, size), P(0.70f, 0.70f, x, y, size));
            // Base right
            crown.AddLine(P(0.70f, 0.70f, x, y, size), P(0.78f, 0.74f, x, y, size));
            crown.AddLine(P(0.78f, 0.74f, x, y, size), P(0.82f, 0.78f, x, y, size));
            crown.AddLine(P(0.82f, 0.78f, x, y, size), P(0.82f, 0.88f, x, y, size));
            // Base bottom
            crown.AddLine(P(0.82f, 0.88f, x, y, size), P(0.18f, 0.88f, x, y, size));
            // Base left
            crown.AddLine(P(0.18f, 0.88f, x, y, size), P(0.18f, 0.78f, x, y, size));
            crown.AddLine(P(0.18f, 0.78f, x, y, size), P(0.22f, 0.74f, x, y, size));
            crown.AddLine(P(0.22f, 0.74f, x, y, size), P(0.30f, 0.70f, x, y, size));
            // Body left
            crown.AddLine(P(0.30f, 0.70f, x, y, size), P(0.26f, 0.50f, x, y, size));
            // Crown band left
            crown.AddLine(P(0.26f, 0.50f, x, y, size), P(0.22f, 0.46f, x, y, size));
            // Left side up
            crown.AddLine(P(0.22f, 0.46f, x, y, size), P(0.14f, 0.26f, x, y, size));

            crown.CloseFigure();
            path.AddPath(crown, false);

            return path;
        }

        private GraphicsPath BuildKingPath(float x, float y, float size)
        {
            var path = new GraphicsPath();

            // Cross at top
            // Vertical bar
            path.AddRectangle(new RectangleF(
                x + 0.46f * size, y + 0.04f * size,
                0.08f * size, 0.16f * size));
            // Horizontal bar
            path.AddRectangle(new RectangleF(
                x + 0.38f * size, y + 0.08f * size,
                0.24f * size, 0.07f * size));

            // Crown band + body + base as one polygon
            var body = new GraphicsPath();
            body.StartFigure();

            // Crown band top (with small zigzag/pointed bottom)
            body.AddLine(P(0.30f, 0.22f, x, y, size), P(0.70f, 0.22f, x, y, size));
            body.AddLine(P(0.70f, 0.22f, x, y, size), P(0.72f, 0.28f, x, y, size));
            // Zigzag bottom of crown band
            body.AddLine(P(0.72f, 0.28f, x, y, size), P(0.66f, 0.34f, x, y, size));
            body.AddLine(P(0.66f, 0.34f, x, y, size), P(0.58f, 0.30f, x, y, size));
            body.AddLine(P(0.58f, 0.30f, x, y, size), P(0.50f, 0.36f, x, y, size));
            body.AddLine(P(0.50f, 0.36f, x, y, size), P(0.42f, 0.30f, x, y, size));
            body.AddLine(P(0.42f, 0.30f, x, y, size), P(0.34f, 0.34f, x, y, size));
            body.AddLine(P(0.34f, 0.34f, x, y, size), P(0.28f, 0.28f, x, y, size));

            // Left side body
            body.AddLine(P(0.28f, 0.28f, x, y, size), P(0.30f, 0.46f, x, y, size));
            // Waist indent
            body.AddLine(P(0.30f, 0.46f, x, y, size), P(0.32f, 0.56f, x, y, size));
            body.AddLine(P(0.32f, 0.56f, x, y, size), P(0.30f, 0.66f, x, y, size));
            // Flare to base left
            body.AddLine(P(0.30f, 0.66f, x, y, size), P(0.34f, 0.72f, x, y, size));
            body.AddLine(P(0.34f, 0.72f, x, y, size), P(0.24f, 0.76f, x, y, size));
            body.AddLine(P(0.24f, 0.76f, x, y, size), P(0.18f, 0.80f, x, y, size));
            body.AddLine(P(0.18f, 0.80f, x, y, size), P(0.18f, 0.88f, x, y, size));
            // Base bottom
            body.AddLine(P(0.18f, 0.88f, x, y, size), P(0.82f, 0.88f, x, y, size));
            // Base right
            body.AddLine(P(0.82f, 0.88f, x, y, size), P(0.82f, 0.80f, x, y, size));
            body.AddLine(P(0.82f, 0.80f, x, y, size), P(0.76f, 0.76f, x, y, size));
            body.AddLine(P(0.76f, 0.76f, x, y, size), P(0.66f, 0.72f, x, y, size));
            // Flare to body right
            body.AddLine(P(0.66f, 0.72f, x, y, size), P(0.70f, 0.66f, x, y, size));
            body.AddLine(P(0.70f, 0.66f, x, y, size), P(0.68f, 0.56f, x, y, size));
            body.AddLine(P(0.68f, 0.56f, x, y, size), P(0.70f, 0.46f, x, y, size));
            // Right side body up
            body.AddLine(P(0.70f, 0.46f, x, y, size), P(0.72f, 0.28f, x, y, size));

            // Back to start (already at crown band top-right -> connect to top-left)
            body.AddLine(P(0.72f, 0.28f, x, y, size), P(0.30f, 0.22f, x, y, size));

            body.CloseFigure();
            path.AddPath(body, false);

            return path;
        }

        // ─── Mouse Handling (unchanged) ─────────────────────────────────

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
                _coordFont?.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
