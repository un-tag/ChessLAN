using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace ChessLAN
{
    public class GameForm : Form
    {
        private BoardControl _boardControl;
        private ChessBoard _board;
        private ChessClock _clock;
        private NetworkManager _network;
        private PlayerDataStore _playerData;
        private PieceColor _myColor;
        private string _opponentId;
        private string _opponentName;
        private int _opponentElo;
        private string _timeControl;
        private bool _gameOver;

        private Label _opponentNameLabel;
        private Label _opponentClockLabel;
        private Label _myNameLabel;
        private Label _myClockLabel;
        private Label _opponentCapturedLabel;
        private Label _myCapturedLabel;
        private Button _resignButton;
        private Button _drawButton;
        private Button _rematchButton;
        private Label _statusLabel;

        private List<Piece> _capturedByMe = new();
        private List<Piece> _capturedByOpponent = new();
        private bool _rematchRequested;
        private bool _opponentRematchRequested;
        private AppSettings _settings;
        private CheckBox _showMovesCheckBox = null!;
        private CheckBox _muteCheckBox = null!;
        private Label _recordLabel = null!;

        public GameForm(NetworkManager network, PlayerDataStore playerData,
                        PieceColor myColor, string opponentId, string opponentName,
                        int opponentElo, string timeControl)
        {
            _network = network;
            _playerData = playerData;
            _myColor = myColor;
            _opponentId = opponentId;
            _opponentName = opponentName;
            _opponentElo = opponentElo;
            _timeControl = timeControl;

            _settings = AppSettings.Load();

            _board = new ChessBoard();
            _board.SetupInitialPosition();

            var (initialTime, increment) = ParseTimeControl(timeControl);
            _clock = new ChessClock(initialTime, increment);

            InitializeUI();
            WireEvents();
            Resize += (s, ev) => LayoutControls();
            Load += (s, ev) => LayoutControls();

            // Start the clock for white
            _boardControl.Board = _board;
            _boardControl.MyColor = _myColor;
            _boardControl.IsMyTurn = _myColor == PieceColor.White;
            _boardControl.Invalidate();

            _clock.Start(PieceColor.White);
        }

        private void InitializeUI()
        {
            Text = $"ChessLAN - {_playerData.Me.Name} vs {_opponentName}";
            WindowState = FormWindowState.Maximized;
            FormBorderStyle = FormBorderStyle.Sizable;
            MinimumSize = new Size(700, 500);
            BackColor = Color.FromArgb(40, 40, 40);
            KeyPreview = true;
            KeyDown += (s, ev) => { if (ev.KeyCode == Keys.Escape) Close(); };

            // Board control (will be positioned by LayoutControls)
            _boardControl = new BoardControl
            {
                ShowLegalMoves = _settings.ShowLegalMoves
            };
            Controls.Add(_boardControl);

            // Placeholder values — LayoutControls sets final positions
            int panelX = 0;
            int panelWidth = 300;

            int boardTop = _boardControl.Top;
            int boardBottom = _boardControl.Bottom;
            int panelMidY = (boardTop + boardBottom) / 2;

            // Opponent name + Elo
            _opponentNameLabel = new Label
            {
                Text = $"{_opponentName} ({_opponentElo})",
                Location = new Point(panelX, boardTop),
                Size = new Size(panelWidth, 28),
                Font = new Font("Segoe UI", 12f, FontStyle.Bold),
                ForeColor = Color.White,
                TextAlign = ContentAlignment.MiddleLeft
            };
            Controls.Add(_opponentNameLabel);

            // Opponent clock
            _opponentClockLabel = new Label
            {
                Text = FormatTime(_myColor == PieceColor.White
                    ? _clock.BlackTime : _clock.WhiteTime),
                Location = new Point(panelX, boardTop + 32),
                Size = new Size(panelWidth, 55),
                Font = new Font("Consolas", 28f, FontStyle.Bold),
                ForeColor = Color.White,
                BackColor = Color.FromArgb(60, 60, 60),
                TextAlign = ContentAlignment.MiddleCenter
            };
            Controls.Add(_opponentClockLabel);

            // Opponent captured pieces
            _opponentCapturedLabel = new Label
            {
                Text = "",
                Location = new Point(panelX, boardTop + 95),
                Size = new Size(panelWidth, 30),
                Font = new Font("Segoe UI Symbol", 16f),
                ForeColor = Color.LightGray
            };
            Controls.Add(_opponentCapturedLabel);

            // --- Middle section ---
            // Status label
            _statusLabel = new Label
            {
                Text = _myColor == PieceColor.White ? "Your turn" : "Opponent's turn",
                Location = new Point(panelX, panelMidY - 60),
                Size = new Size(panelWidth, 25),
                Font = new Font("Segoe UI", 11f),
                ForeColor = Color.FromArgb(180, 200, 180),
                TextAlign = ContentAlignment.MiddleCenter
            };
            Controls.Add(_statusLabel);

            // Head to head record
            var (wins, losses, draws) = _playerData.GetRecord(_opponentId);
            _recordLabel = new Label
            {
                Text = $"Record: {wins}W - {losses}L - {draws}D",
                Location = new Point(panelX, panelMidY - 30),
                Size = new Size(panelWidth, 22),
                Font = new Font("Segoe UI", 9f),
                ForeColor = Color.FromArgb(150, 150, 150),
                TextAlign = ContentAlignment.MiddleCenter
            };
            Controls.Add(_recordLabel);

            // Buttons
            _resignButton = new Button
            {
                Text = "Resign",
                Location = new Point(panelX, panelMidY + 5),
                Size = new Size(90, 38),
                Font = new Font("Segoe UI", 9f, FontStyle.Bold),
                BackColor = Color.FromArgb(180, 60, 60),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            _resignButton.FlatAppearance.BorderSize = 0;
            _resignButton.Click += OnResignClick;
            Controls.Add(_resignButton);

            _drawButton = new Button
            {
                Text = "Offer Draw",
                Location = new Point(panelX + 100, panelMidY + 5),
                Size = new Size(95, 38),
                Font = new Font("Segoe UI", 9f, FontStyle.Bold),
                BackColor = Color.FromArgb(120, 120, 120),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            _drawButton.FlatAppearance.BorderSize = 0;
            _drawButton.Click += OnDrawClick;
            Controls.Add(_drawButton);

            _rematchButton = new Button
            {
                Text = "Rematch",
                Location = new Point(panelX + 205, panelMidY + 5),
                Size = new Size(95, 38),
                Font = new Font("Segoe UI", 9f, FontStyle.Bold),
                BackColor = Color.FromArgb(52, 120, 200),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Visible = false
            };
            _rematchButton.FlatAppearance.BorderSize = 0;
            _rematchButton.Click += OnRematchClick;
            Controls.Add(_rematchButton);

            // Show legal moves toggle
            _showMovesCheckBox = new CheckBox
            {
                Text = "Show Legal Moves",
                Checked = _settings.ShowLegalMoves,
                Location = new Point(panelX, panelMidY + 55),
                Size = new Size(panelWidth, 24),
                Font = new Font("Segoe UI", 9f),
                ForeColor = Color.LightGray
            };
            _showMovesCheckBox.CheckedChanged += (s, ev) =>
            {
                _settings.ShowLegalMoves = _showMovesCheckBox.Checked;
                _settings.Save();
                _boardControl.ShowLegalMoves = _showMovesCheckBox.Checked;
                _boardControl.Invalidate();
            };
            Controls.Add(_showMovesCheckBox);

            // Mute toggle
            _muteCheckBox = new CheckBox
            {
                Text = "Mute Sound",
                Checked = _settings.Muted,
                Location = new Point(0, 0), // set by LayoutControls
                Size = new Size(panelWidth, 24),
                Font = new Font("Segoe UI", 9f),
                ForeColor = Color.LightGray
            };
            _muteCheckBox.CheckedChanged += (s, ev) =>
            {
                _settings.Muted = _muteCheckBox.Checked;
                _settings.Save();
                SoundManager.Muted = _muteCheckBox.Checked;
            };
            Controls.Add(_muteCheckBox);

            // Initialize mute state
            SoundManager.Muted = _settings.Muted;

            // --- Bottom section ---
            // My captured pieces
            _myCapturedLabel = new Label
            {
                Text = "",
                Location = new Point(panelX, boardBottom - 130),
                Size = new Size(panelWidth, 30),
                Font = new Font("Segoe UI Symbol", 16f),
                ForeColor = Color.LightGray
            };
            Controls.Add(_myCapturedLabel);

            // My clock
            _myClockLabel = new Label
            {
                Text = FormatTime(_myColor == PieceColor.White
                    ? _clock.WhiteTime : _clock.BlackTime),
                Location = new Point(panelX, boardBottom - 90),
                Size = new Size(panelWidth, 55),
                Font = new Font("Consolas", 28f, FontStyle.Bold),
                ForeColor = Color.White,
                BackColor = Color.FromArgb(60, 60, 60),
                TextAlign = ContentAlignment.MiddleCenter
            };
            Controls.Add(_myClockLabel);

            // My name + Elo
            _myNameLabel = new Label
            {
                Text = $"{_playerData.Me.Name} ({_playerData.Me.Elo})",
                Location = new Point(panelX, boardBottom - 30),
                Size = new Size(panelWidth, 28),
                Font = new Font("Segoe UI", 12f, FontStyle.Bold),
                ForeColor = Color.White,
                TextAlign = ContentAlignment.MiddleLeft
            };
            Controls.Add(_myNameLabel);
        }

        private void LayoutControls()
        {
            int cw = ClientSize.Width;
            int ch = ClientSize.Height;
            int margin = 20;

            // Board: square, fitted to height with room for the side panel
            int boardSize = Math.Min(ch - margin * 2, cw - 350);
            boardSize = Math.Max(160, (boardSize / 8) * 8);

            int boardX = margin;
            int boardY = (ch - boardSize) / 2;

            _boardControl.Location = new Point(boardX, boardY);
            _boardControl.Size = new Size(boardSize, boardSize);

            int px = _boardControl.Right + 30;
            int pw = Math.Max(200, cw - px - margin);
            int bt = boardY;
            int bb = boardY + boardSize;
            int mid = (bt + bb) / 2;

            _opponentNameLabel.Location = new Point(px, bt);
            _opponentNameLabel.Size = new Size(pw, 28);

            _opponentClockLabel.Location = new Point(px, bt + 32);
            _opponentClockLabel.Size = new Size(pw, 55);

            _opponentCapturedLabel.Location = new Point(px, bt + 95);
            _opponentCapturedLabel.Size = new Size(pw, 30);

            _statusLabel.Location = new Point(px, mid - 60);
            _statusLabel.Size = new Size(pw, 25);

            _recordLabel.Location = new Point(px, mid - 30);
            _recordLabel.Size = new Size(pw, 22);

            _resignButton.Location = new Point(px, mid + 5);
            _drawButton.Location = new Point(px + 100, mid + 5);
            _rematchButton.Location = new Point(px + 205, mid + 5);

            _showMovesCheckBox.Location = new Point(px, mid + 55);
            _showMovesCheckBox.Size = new Size(pw, 24);

            _muteCheckBox.Location = new Point(px, mid + 80);
            _muteCheckBox.Size = new Size(pw, 24);

            _myCapturedLabel.Location = new Point(px, bb - 130);
            _myCapturedLabel.Size = new Size(pw, 30);

            _myClockLabel.Location = new Point(px, bb - 90);
            _myClockLabel.Size = new Size(pw, 55);

            _myNameLabel.Location = new Point(px, bb - 30);
            _myNameLabel.Size = new Size(pw, 28);
        }

        private void WireEvents()
        {
            _boardControl.MoveMade += OnMoveMade;
            _boardControl.PremoveMade += OnPremoveMade;

            _network.MoveReceived += OnMoveReceived;
            _network.ResignReceived += OnResignReceived;
            _network.DrawOffered += OnDrawOffered;
            _network.DrawResponseReceived += OnDrawResponseReceived;
            _network.ClockSyncReceived += OnClockSyncReceived;
            _network.Disconnected += OnDisconnected;
            _network.RematchRequested += OnRematchRequested;

            _clock.TimeUpdated += OnTimeUpdated;
            _clock.FlagFell += OnFlagFell;
        }

        private void UnwireNetworkEvents()
        {
            _network.MoveReceived -= OnMoveReceived;
            _network.ResignReceived -= OnResignReceived;
            _network.DrawOffered -= OnDrawOffered;
            _network.DrawResponseReceived -= OnDrawResponseReceived;
            _network.ClockSyncReceived -= OnClockSyncReceived;
            _network.Disconnected -= OnDisconnected;
            _network.RematchRequested -= OnRematchRequested;
        }

        private void OnMoveMade(Move move)
        {
            if (_gameOver) return;
            if (_board.Turn != _myColor) return;

            // Apply move
            var result = _board.MakeMove(move);

            // Track captures
            if (result.IsCapture && !result.CapturedPiece.IsEmpty)
            {
                _capturedByMe.Add(result.CapturedPiece);
                UpdateCapturedDisplay();
            }

            _boardControl.SetLastMove(move);
            _boardControl.Board = _board;
            _boardControl.IsMyTurn = false;
            _boardControl.Invalidate();

            // Play sound
            PlayMoveSound(result);

            // Switch clock
            _clock.SwitchTo(_myColor == PieceColor.White ? PieceColor.Black : PieceColor.White);

            // Send move to opponent
            _network.SendMove(new MoveMessage
            {
                Move = move.ToAlgebraic(),
                WhiteTimeMs = _clock.WhiteTime.TotalMilliseconds,
                BlackTimeMs = _clock.BlackTime.TotalMilliseconds
            });

            UpdateStatus();

            // Check game over
            if (result.IsCheckmate || result.IsDraw || result.IsStalemate)
            {
                HandleGameOver(result.GameOverReason ?? "Game Over");
            }
        }

        private void OnPremoveMade(Move move)
        {
            // Premove is stored in BoardControl, nothing extra needed here
        }

        private void OnMoveReceived(MoveMessage msg)
        {
            if (InvokeRequired)
            {
                BeginInvoke(() => OnMoveReceived(msg));
                return;
            }

            if (_gameOver) return;

            var move = ChessLAN.Move.FromAlgebraic(msg.Move);

            // Animate the move
            _boardControl.AnimateMove(move, () =>
            {
                // Apply move after animation
                var result = _board.MakeMove(move);

                // Track captures
                if (result.IsCapture && !result.CapturedPiece.IsEmpty)
                {
                    _capturedByOpponent.Add(result.CapturedPiece);
                    UpdateCapturedDisplay();
                }

                _boardControl.SetLastMove(move);
                _boardControl.Board = _board;
                _boardControl.Invalidate();

                // Play sound
                PlayMoveSound(result);

                // Sync clock
                _clock.SetTimes(
                    TimeSpan.FromMilliseconds(msg.WhiteTimeMs),
                    TimeSpan.FromMilliseconds(msg.BlackTimeMs)
                );
                _clock.SwitchTo(_myColor);

                // Check game over
                if (result.IsCheckmate || result.IsDraw || result.IsStalemate)
                {
                    HandleGameOver(result.GameOverReason ?? "Game Over");
                    return;
                }

                // It's now my turn
                _boardControl.IsMyTurn = true;
                UpdateStatus();

                // Check for premove
                var premove = _boardControl.GetAndClearPremove();
                if (premove.HasValue)
                {
                    // Verify the premove is still legal
                    var legalMoves = _board.GetLegalMoves();
                    var matchingLegal = legalMoves.FirstOrDefault(m =>
                        m.FromRow == premove.Value.FromRow && m.FromCol == premove.Value.FromCol &&
                        m.ToRow == premove.Value.ToRow && m.ToCol == premove.Value.ToCol &&
                        (premove.Value.Promotion == PieceType.None || m.Promotion == premove.Value.Promotion));

                    if (legalMoves.Any(m =>
                        m.FromRow == premove.Value.FromRow && m.FromCol == premove.Value.FromCol &&
                        m.ToRow == premove.Value.ToRow && m.ToCol == premove.Value.ToCol))
                    {
                        // Find the exact legal move (with correct promotion if needed)
                        var exactMove = legalMoves.First(m =>
                            m.FromRow == premove.Value.FromRow && m.FromCol == premove.Value.FromCol &&
                            m.ToRow == premove.Value.ToRow && m.ToCol == premove.Value.ToCol &&
                            (premove.Value.Promotion == PieceType.None || m.Promotion == premove.Value.Promotion));

                        // Execute premove
                        OnMoveMade(exactMove);
                    }
                }
            });
        }

        private void OnResignReceived()
        {
            if (InvokeRequired)
            {
                BeginInvoke(OnResignReceived);
                return;
            }

            string winner = _myColor == PieceColor.White ? "White" : "Black";
            HandleGameOver($"{winner} wins - opponent resigned");
        }

        private void OnDrawOffered()
        {
            if (InvokeRequired)
            {
                BeginInvoke(OnDrawOffered);
                return;
            }

            if (_gameOver) return;

            var result = MessageBox.Show(
                $"{_opponentName} offers a draw. Accept?",
                "Draw Offer",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question
            );

            bool accepted = result == DialogResult.Yes;
            _network.SendDrawResponse(accepted);

            if (accepted)
            {
                HandleGameOver("Draw by agreement");
            }
        }

        private void OnDrawResponseReceived(bool accepted)
        {
            if (InvokeRequired)
            {
                BeginInvoke(() => OnDrawResponseReceived(accepted));
                return;
            }

            if (accepted)
            {
                HandleGameOver("Draw by agreement");
            }
            else
            {
                MessageBox.Show("Draw offer declined.", "Draw", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }

        private void OnClockSyncReceived(ClockSyncMessage msg)
        {
            if (InvokeRequired)
            {
                BeginInvoke(() => OnClockSyncReceived(msg));
                return;
            }

            _clock.SetTimes(
                TimeSpan.FromMilliseconds(msg.WhiteTimeMs),
                TimeSpan.FromMilliseconds(msg.BlackTimeMs)
            );
        }

        private void OnDisconnected()
        {
            if (InvokeRequired)
            {
                BeginInvoke(OnDisconnected);
                return;
            }

            if (!_gameOver)
            {
                HandleGameOver("Opponent disconnected");
            }
        }

        private void OnRematchRequested()
        {
            if (InvokeRequired)
            {
                BeginInvoke(OnRematchRequested);
                return;
            }

            _opponentRematchRequested = true;

            if (_rematchRequested && _opponentRematchRequested)
            {
                StartRematch();
            }
            else
            {
                _statusLabel.Text = "Opponent wants a rematch!";
            }
        }

        private void OnTimeUpdated()
        {
            if (InvokeRequired)
            {
                BeginInvoke(OnTimeUpdated);
                return;
            }

            UpdateClockDisplay();
        }

        private void OnFlagFell(PieceColor color)
        {
            if (InvokeRequired)
            {
                BeginInvoke(() => OnFlagFell(color));
                return;
            }

            string winner = color == PieceColor.White ? "Black" : "White";
            HandleGameOver($"{winner} wins on time");
        }

        private void OnResignClick(object? sender, EventArgs e)
        {
            if (_gameOver) return;

            var result = MessageBox.Show("Are you sure you want to resign?", "Resign",
                MessageBoxButtons.YesNo, MessageBoxIcon.Question);

            if (result == DialogResult.Yes)
            {
                _network.SendResign();
                string winner = _myColor == PieceColor.White ? "Black" : "White";
                HandleGameOver($"{winner} wins - you resigned");
            }
        }

        private void OnDrawClick(object? sender, EventArgs e)
        {
            if (_gameOver) return;

            _network.SendDrawOffer();
            _statusLabel.Text = "Draw offer sent...";
        }

        private void OnRematchClick(object? sender, EventArgs e)
        {
            _rematchRequested = true;
            _network.SendRematch();
            _rematchButton.Enabled = false;
            _rematchButton.Text = "Waiting...";

            if (_rematchRequested && _opponentRematchRequested)
            {
                StartRematch();
            }
        }

        private void HandleGameOver(string reason)
        {
            if (_gameOver) return;
            _gameOver = true;

            _clock.Stop();
            _boardControl.IsMyTurn = false;
            _boardControl.ClearPremove();

            SoundManager.PlayGameEnd();

            // Determine result for recording
            string result;
            if (reason.Contains("draw", StringComparison.OrdinalIgnoreCase) ||
                reason.Contains("stalemate", StringComparison.OrdinalIgnoreCase))
            {
                result = "draw";
            }
            else if (reason.Contains("White wins", StringComparison.OrdinalIgnoreCase))
            {
                result = "white";
            }
            else if (reason.Contains("Black wins", StringComparison.OrdinalIgnoreCase))
            {
                result = "black";
            }
            else if (reason.Contains("disconnected", StringComparison.OrdinalIgnoreCase))
            {
                // Opponent disconnected = we win
                result = _myColor == PieceColor.White ? "white" : "black";
            }
            else
            {
                result = "draw";
            }

            bool iPlayedWhite = _myColor == PieceColor.White;
            _playerData.RecordGame(_opponentId, _opponentName, _opponentElo, iPlayedWhite, result, reason, _timeControl);

            // Update UI
            _statusLabel.Text = reason;
            _statusLabel.ForeColor = Color.FromArgb(255, 200, 100);
            _resignButton.Enabled = false;
            _drawButton.Enabled = false;
            _rematchButton.Visible = true;
            _rematchButton.Enabled = true;
            _myNameLabel.Text = $"{_playerData.Me.Name} ({_playerData.Me.Elo})";

            MessageBox.Show(reason, "Game Over", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private void StartRematch()
        {
            // Swap colors
            PieceColor newColor = _myColor == PieceColor.White ? PieceColor.Black : PieceColor.White;

            // Reset board
            _board = new ChessBoard();
            _board.SetupInitialPosition();

            _capturedByMe.Clear();
            _capturedByOpponent.Clear();
            _gameOver = false;
            _rematchRequested = false;
            _opponentRematchRequested = false;

            _myColor = newColor;
            _boardControl.Board = _board;
            _boardControl.MyColor = _myColor;
            _boardControl.IsMyTurn = _myColor == PieceColor.White;
            _boardControl.ClearPremove();
            _boardControl.SetLastMove(new Move()); // Clear last move highlight
            _boardControl.Invalidate();

            var (initialTime, increment) = ParseTimeControl(_timeControl);
            _clock.Dispose();
            _clock = new ChessClock(initialTime, increment);
            _clock.TimeUpdated += OnTimeUpdated;
            _clock.FlagFell += OnFlagFell;
            _clock.Start(PieceColor.White);

            _resignButton.Enabled = true;
            _drawButton.Enabled = true;
            _rematchButton.Visible = false;
            _rematchButton.Text = "Rematch";
            _statusLabel.ForeColor = Color.FromArgb(180, 200, 180);

            UpdateCapturedDisplay();
            UpdateClockDisplay();
            UpdateStatus();

            Text = $"ChessLAN - {_playerData.Me.Name} vs {_opponentName}";
            SoundManager.PlayGameStart();
        }

        private void UpdateClockDisplay()
        {
            TimeSpan myTime = _myColor == PieceColor.White ? _clock.WhiteTime : _clock.BlackTime;
            TimeSpan oppTime = _myColor == PieceColor.White ? _clock.BlackTime : _clock.WhiteTime;

            _myClockLabel.Text = FormatTime(myTime);
            _opponentClockLabel.Text = FormatTime(oppTime);

            // Highlight active clock
            bool myTurn = _clock.ActiveColor == _myColor;
            _myClockLabel.BackColor = myTurn ? Color.FromArgb(50, 80, 50) : Color.FromArgb(60, 60, 60);
            _opponentClockLabel.BackColor = !myTurn ? Color.FromArgb(50, 80, 50) : Color.FromArgb(60, 60, 60);

            // Red when low time
            _myClockLabel.ForeColor = myTime.TotalSeconds < 30 ? Color.FromArgb(255, 80, 80) : Color.White;
            _opponentClockLabel.ForeColor = oppTime.TotalSeconds < 30 ? Color.FromArgb(255, 80, 80) : Color.White;
        }

        private void UpdateStatus()
        {
            if (_gameOver) return;
            bool myTurn = _board.Turn == _myColor;
            _statusLabel.Text = myTurn ? "Your turn" : "Opponent's turn";

            if (_board.IsInCheck(_board.Turn))
            {
                _statusLabel.Text += " - CHECK!";
                _statusLabel.ForeColor = Color.FromArgb(255, 120, 120);
            }
            else
            {
                _statusLabel.ForeColor = Color.FromArgb(180, 200, 180);
            }
        }

        private void UpdateCapturedDisplay()
        {
            _myCapturedLabel.Text = FormatCaptured(_capturedByMe);
            _opponentCapturedLabel.Text = FormatCaptured(_capturedByOpponent);
        }

        private static string FormatCaptured(List<Piece> pieces)
        {
            if (pieces.Count == 0) return "";

            // Sort by value: Q, R, B, N, P
            var ordered = pieces.OrderByDescending(p => PieceValue(p.Type));
            var sb = new System.Text.StringBuilder();
            foreach (var p in ordered)
            {
                sb.Append(GetCapturedUnicode(p));
            }
            return sb.ToString();
        }

        private static string GetCapturedUnicode(Piece piece)
        {
            if (piece.Color == PieceColor.White)
            {
                return piece.Type switch
                {
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
                    PieceType.Queen => "\u265B",
                    PieceType.Rook => "\u265C",
                    PieceType.Bishop => "\u265D",
                    PieceType.Knight => "\u265E",
                    PieceType.Pawn => "\u265F",
                    _ => ""
                };
            }
        }

        private static int PieceValue(PieceType type) => type switch
        {
            PieceType.Queen => 9,
            PieceType.Rook => 5,
            PieceType.Bishop => 3,
            PieceType.Knight => 3,
            PieceType.Pawn => 1,
            _ => 0
        };

        private static string FormatTime(TimeSpan time)
        {
            if (time < TimeSpan.Zero) time = TimeSpan.Zero;
            if (time.TotalSeconds < 60)
            {
                return $"{time.Seconds:D1}.{time.Milliseconds / 100:D1}";
            }
            return $"{(int)time.TotalMinutes}:{time.Seconds:D2}";
        }

        private void PlayMoveSound(MoveResult result)
        {
            if (result.IsCheck || result.IsCheckmate)
                SoundManager.PlayCheck();
            else if (result.IsCapture)
                SoundManager.PlayCapture();
            else
                SoundManager.PlayMove();
        }

        private static (TimeSpan time, int increment) ParseTimeControl(string tc)
        {
            tc = tc.Trim();

            // Format: "X+Y" (minutes + increment seconds)
            if (tc.Contains('+'))
            {
                var parts = tc.Split('+');
                if (parts.Length == 2 &&
                    int.TryParse(parts[0].Trim(), out int mins) &&
                    int.TryParse(parts[1].Trim(), out int inc))
                {
                    return (TimeSpan.FromMinutes(mins), inc);
                }
            }

            // Format: "X min"
            if (tc.EndsWith("min", StringComparison.OrdinalIgnoreCase))
            {
                string numPart = tc.Replace("min", "").Trim();
                if (int.TryParse(numPart, out int mins))
                {
                    return (TimeSpan.FromMinutes(mins), 0);
                }
            }

            // Default
            return (TimeSpan.FromMinutes(5), 0);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            UnwireNetworkEvents();
            _clock?.Dispose();
            base.OnFormClosing(e);
        }
    }
}
