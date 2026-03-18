using System;
using System.IO;
using System.Media;

namespace ChessLAN
{
    public static class SoundManager
    {
        public static bool Muted { get; set; }

        // Pre-generated WAV data cached at startup to avoid generation lag
        private static readonly byte[] _moveWav;
        private static readonly byte[] _captureWav;
        private static readonly byte[] _checkWav;
        private static readonly byte[] _gameStartWav;
        private static readonly byte[] _gameEndWav;

        // Single reusable player to prevent overlap/cutoff issues
        private static SoundPlayer? _player;
        private static readonly object _lock = new();

        static SoundManager()
        {
            // Pre-generate all sounds once
            _moveWav = GenerateMove();
            _captureWav = GenerateCapture();
            _checkWav = GenerateCheck();
            _gameStartWav = GenerateGameStart();
            _gameEndWav = GenerateGameEnd();
        }

        public static void PlayMove()
        {
            if (!Muted) Play(_moveWav);
        }

        public static void PlayCapture()
        {
            if (!Muted) Play(_captureWav);
        }

        public static void PlayCheck()
        {
            if (!Muted) Play(_checkWav);
        }

        public static void PlayGameStart()
        {
            if (!Muted) Play(_gameStartWav);
        }

        public static void PlayGameEnd()
        {
            if (!Muted) Play(_gameEndWav);
        }

        private static void Play(byte[] wavData)
        {
            lock (_lock)
            {
                try
                {
                    _player?.Stop();
                    _player?.Dispose();
                    var ms = new MemoryStream(wavData);
                    _player = new SoundPlayer(ms);
                    _player.Play();
                }
                catch { }
            }
        }

        // ── Sound generation ──

        // Move: short crisp wooden "tap"
        private static byte[] GenerateMove()
        {
            return BuildWav(Synthesize(durationMs: 35, parts: new[]
            {
                new TonePart(800, 0.20, 40.0),
                new TonePart(1200, 0.08, 50.0),
            }, noiseAmount: 0.35));
        }

        // Capture: punchy "thud" with more body
        private static byte[] GenerateCapture()
        {
            return BuildWav(Synthesize(durationMs: 60, parts: new[]
            {
                new TonePart(300, 0.30, 25.0),
                new TonePart(600, 0.15, 35.0),
            }, noiseAmount: 0.4));
        }

        // Check: sharp metallic ping
        private static byte[] GenerateCheck()
        {
            return BuildWav(Synthesize(durationMs: 80, parts: new[]
            {
                new TonePart(900, 0.25, 20.0),
                new TonePart(1350, 0.15, 30.0),
            }, noiseAmount: 0.1));
        }

        // Game start: two quick ascending pops
        private static byte[] GenerateGameStart()
        {
            var part1 = Synthesize(durationMs: 50, parts: new[]
            {
                new TonePart(500, 0.18, 25.0),
            }, noiseAmount: 0.2);
            var gap = new byte[44100 * 2 * 40 / 1000]; // 40ms silence
            var part2 = Synthesize(durationMs: 60, parts: new[]
            {
                new TonePart(700, 0.22, 22.0),
            }, noiseAmount: 0.2);

            var combined = new byte[part1.Length + gap.Length + part2.Length];
            Buffer.BlockCopy(part1, 0, combined, 0, part1.Length);
            Buffer.BlockCopy(part2, 0, combined, part1.Length + gap.Length, part2.Length);
            return BuildWav(combined);
        }

        // Game end: two descending tones
        private static byte[] GenerateGameEnd()
        {
            var part1 = Synthesize(durationMs: 80, parts: new[]
            {
                new TonePart(550, 0.2, 15.0),
            }, noiseAmount: 0.15);
            var gap = new byte[44100 * 2 * 60 / 1000]; // 60ms silence
            var part2 = Synthesize(durationMs: 120, parts: new[]
            {
                new TonePart(350, 0.18, 12.0),
            }, noiseAmount: 0.15);

            var combined = new byte[part1.Length + gap.Length + part2.Length];
            Buffer.BlockCopy(part1, 0, combined, 0, part1.Length);
            Buffer.BlockCopy(part2, 0, combined, part1.Length + gap.Length, part2.Length);
            return BuildWav(combined);
        }

        private record struct TonePart(int FreqHz, double Volume, double DecayRate);

        private static byte[] Synthesize(int durationMs, TonePart[] parts, double noiseAmount)
        {
            int sampleRate = 44100;
            int numSamples = sampleRate * durationMs / 1000;
            byte[] data = new byte[numSamples * 2];
            var rng = new Random(42);

            for (int i = 0; i < numSamples; i++)
            {
                double t = (double)i / sampleRate;
                double progress = (double)i / numSamples;
                double sample = 0;

                foreach (var part in parts)
                {
                    double envelope = Math.Exp(-part.DecayRate * progress);
                    double sine = Math.Sin(2.0 * Math.PI * part.FreqHz * t);
                    sample += sine * envelope * part.Volume;
                }

                // Add noise texture
                double noise = (rng.NextDouble() * 2.0 - 1.0) * noiseAmount;
                double noiseEnvelope = Math.Exp(-50.0 * progress); // noise fades fast
                sample += noise * noiseEnvelope;

                sample = Math.Clamp(sample, -0.95, 0.95);
                short pcm = (short)(sample * short.MaxValue);
                data[i * 2] = (byte)(pcm & 0xFF);
                data[i * 2 + 1] = (byte)((pcm >> 8) & 0xFF);
            }

            return data;
        }

        private static byte[] BuildWav(byte[] pcmData)
        {
            int sampleRate = 44100;
            short bitsPerSample = 16;
            short channels = 1;
            int byteRate = sampleRate * channels * bitsPerSample / 8;
            short blockAlign = (short)(channels * bitsPerSample / 8);
            int dataSize = pcmData.Length;

            using var ms = new MemoryStream();
            using var bw = new BinaryWriter(ms);

            bw.Write(new char[] { 'R', 'I', 'F', 'F' });
            bw.Write(36 + dataSize);
            bw.Write(new char[] { 'W', 'A', 'V', 'E' });
            bw.Write(new char[] { 'f', 'm', 't', ' ' });
            bw.Write(16);
            bw.Write((short)1);
            bw.Write(channels);
            bw.Write(sampleRate);
            bw.Write(byteRate);
            bw.Write(blockAlign);
            bw.Write(bitsPerSample);
            bw.Write(new char[] { 'd', 'a', 't', 'a' });
            bw.Write(dataSize);
            bw.Write(pcmData);

            bw.Flush();
            return ms.ToArray();
        }
    }
}
