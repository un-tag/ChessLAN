using System.IO;
using System.Text.Json;

namespace ChessLAN
{
    public class AppSettings
    {
        public bool ShowLegalMoves { get; set; } = true;
        public bool Muted { get; set; } = false;
        public string LastHostName { get; set; } = "";

        private static readonly string FilePath = Path.Combine(AppContext.BaseDirectory, "chess_settings.json");
        private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = true };

        public static AppSettings Load()
        {
            try
            {
                if (File.Exists(FilePath))
                {
                    string json = File.ReadAllText(FilePath);
                    return JsonSerializer.Deserialize<AppSettings>(json, JsonOpts) ?? new AppSettings();
                }
            }
            catch { }
            return new AppSettings();
        }

        public void Save()
        {
            try
            {
                string json = JsonSerializer.Serialize(this, JsonOpts);
                File.WriteAllText(FilePath, json);
            }
            catch { }
        }
    }
}
