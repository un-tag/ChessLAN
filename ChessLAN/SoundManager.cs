using System;
using System.IO;
using System.Media;

namespace ChessLAN
{
    public static class SoundManager
    {
        public static bool Muted { get; set; }

        // Chess.com-style sounds: short, crisp, satisfying

        public static void PlayMove()
        {
            if (Muted) return;
            // Soft wooden "tap" — short noise burst with fast decay
            PlayNoise(frequency: 800, durationMs: 40, volume: 0.25, decayRate: 30.0);
        }

        public static void PlayCapture()
        {
            if (Muted) return;
            // Punchy "thwack" — lower frequency, slightly longer, louder
            PlayNoise(frequency: 400, durationMs: 70, volume: 0.4, decayRate: 20.0);
        }

        public static void PlayCheck()
        {
            if (Muted) return;
            // Sharp alert ping
            PlayCompound(new[]
            {
                (freq: 880, durationMs: 60, vol: 0.3, decay: 25.0),
                (freq: 1200, durationMs: 40, vol: 0.2, decay: 35.0),
            });
        }

        public static void PlayGameStart()
        {
            if (Muted) return;
            // Two ascending tones
            PlayCompound(new[]
            {
                (freq: 440, durationMs: 80, vol: 0.2, decay: 15.0),
                (freq: 660, durationMs: 100, vol: 0.25, decay: 15.0),
            });
        }

        public static void PlayGameEnd()
        {
            if (Muted) return;
            // Two descending tones
            PlayCompound(new[]
            {
                (freq: 500, durationMs: 100, vol: 0.25, decay: 12.0),
                (freq: 330, durationMs: 150, vol: 0.2, decay: 10.0),
            });
        }

        private static void PlayNoise(int frequency, int durationMs, double volume, double decayRate)
        {
            int sampleRate = 44100;
            int numSamples = sampleRate * durationMs / 1000;
            byte[] data = new byte[numSamples * 2];
            var rng = new Random(42); // deterministic seed for consistent sound

            for (int i = 0; i < numSamples; i++)
            {
                double t = (double)i / sampleRate;
                double progress = (double)i / numSamples;

                // Exponential decay envelope
                double envelope = Math.Exp(-decayRate * progress);

                // Mix sine tone with filtered noise for a natural "tap" sound
                double sine = Math.Sin(2.0 * Math.PI * frequency * t);
                double noise = (rng.NextDouble() * 2.0 - 1.0) * 0.4;

                // Blend: more tone at start, noise adds texture
                double sample = (sine * 0.7 + noise * 0.3) * envelope * volume;

                // Soft clip
                sample = Math.Clamp(sample, -0.95, 0.95);

                short pcm = (short)(sample * short.MaxValue);
                data[i * 2] = (byte)(pcm & 0xFF);
                data[i * 2 + 1] = (byte)((pcm >> 8) & 0xFF);
            }

            PlayWav(BuildWav(data));
        }

        private static void PlayCompound((int freq, int durationMs, double vol, double decay)[] parts)
        {
            int sampleRate = 44100;
            int totalSamples = 0;
            foreach (var p in parts)
                totalSamples += sampleRate * p.durationMs / 1000;

            byte[] data = new byte[totalSamples * 2];
            int offset = 0;
            var rng = new Random(42);

            foreach (var part in parts)
            {
                int numSamples = sampleRate * part.durationMs / 1000;
                for (int i = 0; i < numSamples; i++)
                {
                    double t = (double)i / sampleRate;
                    double progress = (double)i / numSamples;

                    double envelope = Math.Exp(-part.decay * progress);
                    double sine = Math.Sin(2.0 * Math.PI * part.freq * t);
                    double noise = (rng.NextDouble() * 2.0 - 1.0) * 0.15;
                    double sample = (sine * 0.85 + noise * 0.15) * envelope * part.vol;
                    sample = Math.Clamp(sample, -0.95, 0.95);

                    short pcm = (short)(sample * short.MaxValue);
                    int idx = (offset + i) * 2;
                    data[idx] = (byte)(pcm & 0xFF);
                    data[idx + 1] = (byte)((pcm >> 8) & 0xFF);
                }
                offset += numSamples;
            }

            PlayWav(BuildWav(data));
        }

        private static byte[] BuildWav(byte[] pcmData)
        {
            int sampleRate = 44100;
            short bitsPerSample = 16;
            short channels = 1;
            int byteRate = sampleRate * channels * bitsPerSample / 8;
            short blockAlign = (short)(channels * bitsPerSample / 8);
            int dataSize = pcmData.Length;
            int chunkSize = 36 + dataSize;

            using var ms = new MemoryStream();
            using var bw = new BinaryWriter(ms);

            bw.Write(new char[] { 'R', 'I', 'F', 'F' });
            bw.Write(chunkSize);
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

        private static void PlayWav(byte[] wavData)
        {
            try
            {
                var ms = new MemoryStream(wavData);
                var player = new SoundPlayer(ms);
                player.Play();
            }
            catch { }
        }
    }
}
