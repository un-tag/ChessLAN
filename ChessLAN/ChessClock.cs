using System;
using System.Diagnostics;
using System.Windows.Forms;

namespace ChessLAN
{
    public class ChessClock : IDisposable
    {
        public TimeSpan WhiteTime { get; private set; }
        public TimeSpan BlackTime { get; private set; }
        public int IncrementSeconds { get; }
        public bool IsRunning { get; private set; }
        public PieceColor ActiveColor { get; private set; } = PieceColor.None;

        public event Action? TimeUpdated;
        public event Action<PieceColor>? FlagFell;

        private readonly Stopwatch _stopwatch = new();
        private readonly System.Windows.Forms.Timer _uiTimer;
        private TimeSpan _activeTimeAtStart;
        private bool _disposed;

        public ChessClock(TimeSpan initialTime, int incrementSeconds = 0)
        {
            WhiteTime = initialTime;
            BlackTime = initialTime;
            IncrementSeconds = incrementSeconds;

            _uiTimer = new System.Windows.Forms.Timer();
            _uiTimer.Interval = 100;
            _uiTimer.Tick += OnTick;
        }

        public void Start(PieceColor color)
        {
            ActiveColor = color;
            _activeTimeAtStart = color == PieceColor.White ? WhiteTime : BlackTime;
            _stopwatch.Restart();
            IsRunning = true;
            _uiTimer.Start();
        }

        public void SwitchTo(PieceColor color)
        {
            if (IsRunning)
            {
                // Finalize the elapsed time for the previous active color
                TimeSpan elapsed = _stopwatch.Elapsed;
                ApplyElapsed(elapsed);

                // Add increment to the color that just moved (the previous active color)
                if (ActiveColor == PieceColor.White)
                    WhiteTime = WhiteTime.Add(TimeSpan.FromSeconds(IncrementSeconds));
                else if (ActiveColor == PieceColor.Black)
                    BlackTime = BlackTime.Add(TimeSpan.FromSeconds(IncrementSeconds));
            }

            ActiveColor = color;
            _activeTimeAtStart = color == PieceColor.White ? WhiteTime : BlackTime;
            _stopwatch.Restart();
            IsRunning = true;
            _uiTimer.Start();
            TimeUpdated?.Invoke();
        }

        public void Stop()
        {
            if (IsRunning)
            {
                TimeSpan elapsed = _stopwatch.Elapsed;
                ApplyElapsed(elapsed);
                _stopwatch.Stop();
                IsRunning = false;
                _uiTimer.Stop();
                TimeUpdated?.Invoke();
            }
        }

        public void SetTimes(TimeSpan white, TimeSpan black)
        {
            WhiteTime = white;
            BlackTime = black;
            if (IsRunning)
            {
                _activeTimeAtStart = ActiveColor == PieceColor.White ? WhiteTime : BlackTime;
                _stopwatch.Restart();
            }
            TimeUpdated?.Invoke();
        }

        private void ApplyElapsed(TimeSpan elapsed)
        {
            TimeSpan remaining = _activeTimeAtStart - elapsed;
            if (remaining < TimeSpan.Zero)
                remaining = TimeSpan.Zero;

            if (ActiveColor == PieceColor.White)
                WhiteTime = remaining;
            else if (ActiveColor == PieceColor.Black)
                BlackTime = remaining;
        }

        private void OnTick(object? sender, EventArgs e)
        {
            if (!IsRunning) return;

            TimeSpan elapsed = _stopwatch.Elapsed;
            ApplyElapsed(elapsed);
            TimeUpdated?.Invoke();

            // Check for flag fall
            if (ActiveColor == PieceColor.White && WhiteTime <= TimeSpan.Zero)
            {
                WhiteTime = TimeSpan.Zero;
                Stop();
                FlagFell?.Invoke(PieceColor.White);
            }
            else if (ActiveColor == PieceColor.Black && BlackTime <= TimeSpan.Zero)
            {
                BlackTime = TimeSpan.Zero;
                Stop();
                FlagFell?.Invoke(PieceColor.Black);
            }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _uiTimer.Stop();
            _uiTimer.Dispose();
        }
    }
}
