using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ChessLAN
{
    public class PlayerProfile
    {
        public string Id { get; set; } = Guid.NewGuid().ToString();
        public string Name { get; set; } = "";
        public int Elo { get; set; } = 400;
    }

    public class GameRecord
    {
        public string WhiteId { get; set; } = "";
        public string BlackId { get; set; } = "";
        public string WhiteName { get; set; } = "";
        public string BlackName { get; set; } = "";
        public int WhiteEloBefore { get; set; }
        public int BlackEloBefore { get; set; }
        public int WhiteEloAfter { get; set; }
        public int BlackEloAfter { get; set; }
        public string Result { get; set; } = "";
        public string Reason { get; set; } = "";
        public string TimeControl { get; set; } = "";
        public string Date { get; set; } = "";
        public string Hash { get; set; } = "";
    }

    public class OpponentRecord
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public int Elo { get; set; } = 400;
        public List<GameRecord> Games { get; set; } = new();
    }

    public class PlayerDataStore
    {
        public PlayerProfile Me { get; set; } = new();
        public Dictionary<string, OpponentRecord> Opponents { get; set; } = new();

        private string _filePath;

        private static readonly JsonSerializerOptions _jsonOptions = new()
        {
            WriteIndented = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        };

        public PlayerDataStore(string filePath)
        {
            _filePath = filePath;
        }

        public PlayerDataStore() : this(Path.Combine(AppContext.BaseDirectory, "chess_data.json"))
        {
        }

        public void Load()
        {
            try
            {
                if (!File.Exists(_filePath))
                {
                    Me = new PlayerProfile();
                    Opponents = new Dictionary<string, OpponentRecord>();
                    Save();
                    return;
                }

                string json = File.ReadAllText(_filePath);
                if (string.IsNullOrWhiteSpace(json))
                {
                    Me = new PlayerProfile();
                    Opponents = new Dictionary<string, OpponentRecord>();
                    Save();
                    return;
                }

                var data = JsonSerializer.Deserialize<SaveData>(json, _jsonOptions);
                if (data == null)
                {
                    Me = new PlayerProfile();
                    Opponents = new Dictionary<string, OpponentRecord>();
                    Save();
                    return;
                }

                Me = data.Me ?? new PlayerProfile();
                Opponents = data.Opponents ?? new Dictionary<string, OpponentRecord>();
            }
            catch
            {
                Me = new PlayerProfile();
                Opponents = new Dictionary<string, OpponentRecord>();
                Save();
            }
        }

        public void Save()
        {
            var data = new SaveData
            {
                Me = Me,
                Opponents = Opponents
            };
            string json = JsonSerializer.Serialize(data, _jsonOptions);
            File.WriteAllText(_filePath, json);
        }

        public void RecordGame(string opponentId, string opponentName, int opponentElo,
                               bool iPlayedWhite, string result, string reason, string timeControl)
        {
            // Determine scores
            double myScore;
            if (result == "white")
                myScore = iPlayedWhite ? 1.0 : 0.0;
            else if (result == "black")
                myScore = iPlayedWhite ? 0.0 : 1.0;
            else
                myScore = 0.5;

            int myEloBefore = Me.Elo;
            int oppEloBefore = opponentElo;

            // Calculate new Elo ratings
            var (newMyElo, newOppElo) = CalculateElo(myEloBefore, oppEloBefore, myScore);

            // Build GameRecord
            string whiteId = iPlayedWhite ? Me.Id : opponentId;
            string blackId = iPlayedWhite ? opponentId : Me.Id;
            string whiteName = iPlayedWhite ? Me.Name : opponentName;
            string blackName = iPlayedWhite ? opponentName : Me.Name;
            int whiteEloBefore = iPlayedWhite ? myEloBefore : oppEloBefore;
            int blackEloBefore = iPlayedWhite ? oppEloBefore : myEloBefore;
            int whiteEloAfter = iPlayedWhite ? newMyElo : newOppElo;
            int blackEloAfter = iPlayedWhite ? newOppElo : newMyElo;

            string previousHash = GetLastHash(opponentId);

            var record = new GameRecord
            {
                WhiteId = whiteId,
                BlackId = blackId,
                WhiteName = whiteName,
                BlackName = blackName,
                WhiteEloBefore = whiteEloBefore,
                BlackEloBefore = blackEloBefore,
                WhiteEloAfter = whiteEloAfter,
                BlackEloAfter = blackEloAfter,
                Result = result,
                Reason = reason,
                TimeControl = timeControl,
                Date = DateTime.UtcNow.ToString("o")
            };

            record.Hash = ComputeHash(record, previousHash);

            // Update opponent record
            if (!Opponents.TryGetValue(opponentId, out var oppRecord))
            {
                oppRecord = new OpponentRecord
                {
                    Id = opponentId,
                    Name = opponentName,
                    Elo = newOppElo
                };
                Opponents[opponentId] = oppRecord;
            }
            else
            {
                oppRecord.Name = opponentName;
                oppRecord.Elo = newOppElo;
            }

            oppRecord.Games.Add(record);

            // Update my Elo
            Me.Elo = newMyElo;

            Save();
        }

        public static (int newRatingA, int newRatingB) CalculateElo(int ratingA, int ratingB, double scoreA)
        {
            const int K = 32;

            double expectedA = 1.0 / (1.0 + Math.Pow(10.0, (ratingB - ratingA) / 400.0));
            double expectedB = 1.0 / (1.0 + Math.Pow(10.0, (ratingA - ratingB) / 400.0));

            double scoreB = 1.0 - scoreA;

            int newA = (int)Math.Round(ratingA + K * (scoreA - expectedA));
            int newB = (int)Math.Round(ratingB + K * (scoreB - expectedB));

            return (newA, newB);
        }

        public string ComputeHash(GameRecord record, string previousHash)
        {
            string input = record.WhiteId + record.BlackId + record.Result + record.Reason
                         + record.Date + record.TimeControl + previousHash;

            using var sha256 = SHA256.Create();
            byte[] hashBytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(input));
            return Convert.ToHexString(hashBytes).ToLowerInvariant();
        }

        public bool VerifyChain()
        {
            foreach (var kvp in Opponents)
            {
                var games = kvp.Value.Games;
                string previousHash = "";

                for (int i = 0; i < games.Count; i++)
                {
                    string expected = ComputeHash(games[i], previousHash);
                    if (games[i].Hash != expected)
                        return false;

                    previousHash = games[i].Hash;
                }
            }
            return true;
        }

        public string GetLastHash(string opponentId)
        {
            if (!Opponents.TryGetValue(opponentId, out var oppRecord))
                return "";

            if (oppRecord.Games.Count == 0)
                return "";

            return oppRecord.Games[^1].Hash;
        }

        public string SerializeForSync()
        {
            var data = new SaveData
            {
                Me = Me,
                Opponents = Opponents
            };
            return JsonSerializer.Serialize(data, _jsonOptions);
        }

        public (bool isValid, string? tamperMessage) VerifyAndSync(string otherJson)
        {
            SaveData? otherData;
            try
            {
                otherData = JsonSerializer.Deserialize<SaveData>(otherJson, _jsonOptions);
            }
            catch
            {
                return (false, "Failed to deserialize opponent data.");
            }

            if (otherData?.Me == null || otherData.Opponents == null)
                return (false, "Opponent data is incomplete.");

            string otherId = otherData.Me.Id;

            // Verify the other player's hash chain for games involving us
            if (otherData.Opponents.TryGetValue(Me.Id, out var theirRecordOfUs))
            {
                // Verify their chain
                string previousHash = "";
                for (int i = 0; i < theirRecordOfUs.Games.Count; i++)
                {
                    var game = theirRecordOfUs.Games[i];
                    string expected = ComputeHash(game, previousHash);
                    if (game.Hash != expected)
                    {
                        return (false, $"Opponent's hash chain is broken at game {i + 1}. Their records may have been tampered with.");
                    }
                    previousHash = game.Hash;
                }

                // Cross-reference with our records
                if (Opponents.TryGetValue(otherId, out var ourRecordOfThem))
                {
                    int minCount = Math.Min(ourRecordOfThem.Games.Count, theirRecordOfUs.Games.Count);
                    for (int i = 0; i < minCount; i++)
                    {
                        var ours = ourRecordOfThem.Games[i];
                        var theirs = theirRecordOfUs.Games[i];

                        // The core game data should match
                        if (ours.WhiteId != theirs.WhiteId ||
                            ours.BlackId != theirs.BlackId ||
                            ours.Result != theirs.Result ||
                            ours.Reason != theirs.Reason ||
                            ours.Date != theirs.Date)
                        {
                            // Determine which side tampered by checking our chain
                            string ourPrev = i > 0 ? ourRecordOfThem.Games[i - 1].Hash : "";
                            string ourExpected = ComputeHash(ours, ourPrev);
                            bool ourValid = ours.Hash == ourExpected;

                            string theirPrev = i > 0 ? theirRecordOfUs.Games[i - 1].Hash : "";
                            string theirExpected = ComputeHash(theirs, theirPrev);
                            bool theirValid = theirs.Hash == theirExpected;

                            if (!ourValid && theirValid)
                                return (false, $"Discrepancy at game {i + 1}: Your local records appear tampered.");
                            else if (ourValid && !theirValid)
                                return (false, $"Discrepancy at game {i + 1}: Opponent's records appear tampered.");
                            else
                                return (false, $"Discrepancy at game {i + 1}: Records diverge. Unable to determine which side tampered.");
                        }
                    }

                    // If they have more games than us, it means they recorded games we didn't
                    if (theirRecordOfUs.Games.Count > ourRecordOfThem.Games.Count)
                    {
                        return (false, $"Opponent has {theirRecordOfUs.Games.Count - ourRecordOfThem.Games.Count} extra game(s) not in your records.");
                    }
                }

                // Update opponent's Elo from their data
                if (Opponents.TryGetValue(otherId, out var opp))
                {
                    opp.Elo = otherData.Me.Elo;
                    opp.Name = otherData.Me.Name;
                }
            }

            return (true, null);
        }

        public (int wins, int losses, int draws) GetRecord(string opponentId)
        {
            if (!Opponents.TryGetValue(opponentId, out var oppRecord))
                return (0, 0, 0);

            int wins = 0, losses = 0, draws = 0;
            foreach (var game in oppRecord.Games)
            {
                if (game.Result == "draw")
                {
                    draws++;
                }
                else if (game.Result == "white")
                {
                    if (game.WhiteId == Me.Id)
                        wins++;
                    else
                        losses++;
                }
                else if (game.Result == "black")
                {
                    if (game.BlackId == Me.Id)
                        wins++;
                    else
                        losses++;
                }
            }
            return (wins, losses, draws);
        }

        // Internal serialization wrapper
        private class SaveData
        {
            public PlayerProfile Me { get; set; } = new();
            public Dictionary<string, OpponentRecord> Opponents { get; set; } = new();
        }
    }
}
