using System;
using System.IO;
using System.Media;

namespace ChessLAN
{
    public static class SoundManager
    {
        public static void PlayMove()
        {
            PlayTone(400, 50, 0.3);
        }

        public static void PlayCapture()
        {
            PlayTone(300, 80, 0.4);
        }

        public static void PlayCheck()
        {
            PlayTone(600, 100, 0.35);
        }

        public static void PlayGameStart()
        {
            PlayTone(500, 150, 0.3);
        }

        public static void PlayGameEnd()
        {
            // Two tones concatenated
            byte[] tone1 = GenerateToneSamples(350, 100, 0.3);
            byte[] tone2 = GenerateToneSamples(250, 100, 0.3);
            byte[] allSamples = new byte[tone1.Length + tone2.Length];
            Buffer.BlockCopy(tone1, 0, allSamples, 0, tone1.Length);
            Buffer.BlockCopy(tone2, 0, allSamples, tone1.Length, tone2.Length);
            byte[] wav = BuildWav(allSamples);
            PlayWav(wav);
        }

        private static byte[] GenerateTone(int frequencyHz, int durationMs, double volume = 0.3)
        {
            byte[] samples = GenerateToneSamples(frequencyHz, durationMs, volume);
            return BuildWav(samples);
        }

        private static byte[] GenerateToneSamples(int frequencyHz, int durationMs, double volume)
        {
            int sampleRate = 44100;
            int numSamples = (int)(sampleRate * durationMs / 1000.0);
            byte[] data = new byte[numSamples * 2]; // 16-bit mono

            for (int i = 0; i < numSamples; i++)
            {
                double t = (double)i / sampleRate;
                double sample = Math.Sin(2.0 * Math.PI * frequencyHz * t) * volume;

                // Apply a short fade-in and fade-out to avoid clicks
                int fadeLength = Math.Min(numSamples / 10, 200);
                if (i < fadeLength)
                    sample *= (double)i / fadeLength;
                else if (i > numSamples - fadeLength)
                    sample *= (double)(numSamples - i) / fadeLength;

                short pcmValue = (short)(sample * short.MaxValue);
                data[i * 2] = (byte)(pcmValue & 0xFF);
                data[i * 2 + 1] = (byte)((pcmValue >> 8) & 0xFF);
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
            int chunkSize = 36 + dataSize;

            using var ms = new MemoryStream();
            using var bw = new BinaryWriter(ms);

            // RIFF header
            bw.Write(new char[] { 'R', 'I', 'F', 'F' });
            bw.Write(chunkSize);
            bw.Write(new char[] { 'W', 'A', 'V', 'E' });

            // fmt sub-chunk
            bw.Write(new char[] { 'f', 'm', 't', ' ' });
            bw.Write(16); // sub-chunk size
            bw.Write((short)1); // PCM format
            bw.Write(channels);
            bw.Write(sampleRate);
            bw.Write(byteRate);
            bw.Write(blockAlign);
            bw.Write(bitsPerSample);

            // data sub-chunk
            bw.Write(new char[] { 'd', 'a', 't', 'a' });
            bw.Write(dataSize);
            bw.Write(pcmData);

            bw.Flush();
            return ms.ToArray();
        }

        private static void PlayTone(int frequencyHz, int durationMs, double volume = 0.3)
        {
            byte[] wav = GenerateTone(frequencyHz, durationMs, volume);
            PlayWav(wav);
        }

        private static void PlayWav(byte[] wavData)
        {
            try
            {
                var ms = new MemoryStream(wavData);
                var player = new SoundPlayer(ms);
                player.Play();
            }
            catch
            {
                // Silently fail if audio unavailable
            }
        }
    }
}
