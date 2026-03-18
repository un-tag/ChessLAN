using System;
using System.IO;
using System.IO.Pipes;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace ChessLAN
{
    public enum MessageType
    {
        HostAnnounce,
        Connect,
        ConnectAck,
        GameStart,
        MoveMsg,
        Resign,
        DrawOffer,
        DrawResponse,
        ClockSync,
        SyncData,
        Rematch
    }

    public class NetMessage
    {
        public MessageType Type { get; set; }
        public string? Data { get; set; }
    }

    public class HostInfo
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public int Elo { get; set; }
        public string TimeControl { get; set; } = "5 min";
        public int Port { get; set; }
    }

    public class PlayerInfo
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public int Elo { get; set; }
    }

    public class GameStartInfo
    {
        public bool YouPlayWhite { get; set; }
        public string TimeControl { get; set; } = "";
    }

    public class MoveMessage
    {
        public string Move { get; set; } = "";
        public double WhiteTimeMs { get; set; }
        public double BlackTimeMs { get; set; }
    }

    public class DrawResponseMessage
    {
        public bool Accepted { get; set; }
    }

    public class ClockSyncMessage
    {
        public double WhiteTimeMs { get; set; }
        public double BlackTimeMs { get; set; }
    }

    public class NetworkManager : IDisposable
    {
        public const string PipeName = "ChessLAN";

        private NamedPipeServerStream? _pipeServer;
        private NamedPipeClientStream? _pipeClient;
        private StreamReader? _reader;
        private StreamWriter? _writer;
        private CancellationTokenSource _cts = new();
        private bool _disposed;

        private static readonly JsonSerializerOptions _jsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        };

        // Events
        public event Action<PlayerInfo>? PlayerConnected;
        public event Action<GameStartInfo>? GameStarted;
        public event Action<MoveMessage>? MoveReceived;
        public event Action? ResignReceived;
        public event Action? DrawOffered;
        public event Action<bool>? DrawResponseReceived;
        public event Action<ClockSyncMessage>? ClockSyncReceived;
        public event Action? Disconnected;
        public event Action? RematchRequested;
        public event Action<string>? SyncDataReceived;

        // --- Host Methods ---

        public void StartHosting()
        {
            _cts = new CancellationTokenSource();
        }

        public void StopHosting()
        {
            _cts.Cancel();
            _pipeServer?.Dispose();
            _pipeServer = null;
        }

        public void AcceptConnection()
        {
            var token = _cts.Token;
            Task.Run(async () =>
            {
                try
                {
                    _pipeServer = new NamedPipeServerStream(
                        PipeName,
                        PipeDirection.InOut,
                        1,
                        PipeTransmissionMode.Byte,
                        PipeOptions.Asynchronous);

                    await _pipeServer.WaitForConnectionAsync(token);

                    _reader = new StreamReader(_pipeServer, System.Text.Encoding.UTF8);
                    _writer = new StreamWriter(_pipeServer, System.Text.Encoding.UTF8)
                    {
                        AutoFlush = true
                    };

                    // Read the Connect message
                    string? line = await _reader.ReadLineAsync();
                    if (line != null)
                    {
                        var msg = JsonSerializer.Deserialize<NetMessage>(line, _jsonOptions);
                        if (msg?.Type == MessageType.Connect && msg.Data != null)
                        {
                            var playerInfo = JsonSerializer.Deserialize<PlayerInfo>(msg.Data, _jsonOptions);
                            if (playerInfo != null)
                                PlayerConnected?.Invoke(playerInfo);
                        }
                    }

                    StartReadLoop(token);
                }
                catch (OperationCanceledException) { }
                catch { Disconnected?.Invoke(); }
            }, token);
        }

        public void SendGameStart(GameStartInfo info)
        {
            SendMessage(MessageType.GameStart, info);
        }

        // --- Client Methods ---

        public async Task ConnectToHost(string hostName, PlayerInfo myInfo)
        {
            _cts = new CancellationTokenSource();

            _pipeClient = new NamedPipeClientStream(
                hostName,
                PipeName,
                PipeDirection.InOut,
                PipeOptions.Asynchronous);

            await _pipeClient.ConnectAsync(5000, _cts.Token);

            _reader = new StreamReader(_pipeClient, System.Text.Encoding.UTF8);
            _writer = new StreamWriter(_pipeClient, System.Text.Encoding.UTF8)
            {
                AutoFlush = true
            };

            SendMessage(MessageType.Connect, myInfo);
            StartReadLoop(_cts.Token);
        }

        // --- Shared Methods ---

        public void SendMove(MoveMessage move) => SendMessage(MessageType.MoveMsg, move);
        public void SendResign() => SendMessage(MessageType.Resign, (object?)null);
        public void SendDrawOffer() => SendMessage(MessageType.DrawOffer, (object?)null);
        public void SendDrawResponse(bool accepted) =>
            SendMessage(MessageType.DrawResponse, new DrawResponseMessage { Accepted = accepted });
        public void SendClockSync(double whiteMs, double blackMs) =>
            SendMessage(MessageType.ClockSync, new ClockSyncMessage { WhiteTimeMs = whiteMs, BlackTimeMs = blackMs });
        public void SendSyncData(string jsonData) => SendMessage(MessageType.SyncData, jsonData);
        public void SendRematch() => SendMessage(MessageType.Rematch, (object?)null);

        // --- Private Helpers ---

        private void SendMessage<T>(MessageType type, T payload)
        {
            if (_writer == null) return;
            try
            {
                string? data = payload != null
                    ? (payload is string s ? s : JsonSerializer.Serialize(payload, _jsonOptions))
                    : null;

                var msg = new NetMessage { Type = type, Data = data };
                string json = JsonSerializer.Serialize(msg, _jsonOptions);
                _writer.WriteLine(json);
                _writer.Flush();
            }
            catch { Disconnected?.Invoke(); }
        }

        private void StartReadLoop(CancellationToken token)
        {
            Task.Run(async () =>
            {
                try
                {
                    while (!token.IsCancellationRequested && _reader != null)
                    {
                        string? line = await _reader.ReadLineAsync();
                        if (line == null) { Disconnected?.Invoke(); break; }

                        NetMessage? msg;
                        try { msg = JsonSerializer.Deserialize<NetMessage>(line, _jsonOptions); }
                        catch { continue; }
                        if (msg == null) continue;

                        switch (msg.Type)
                        {
                            case MessageType.Connect:
                                if (msg.Data != null)
                                {
                                    var pi = JsonSerializer.Deserialize<PlayerInfo>(msg.Data, _jsonOptions);
                                    if (pi != null) PlayerConnected?.Invoke(pi);
                                }
                                break;
                            case MessageType.GameStart:
                                if (msg.Data != null)
                                {
                                    var gsi = JsonSerializer.Deserialize<GameStartInfo>(msg.Data, _jsonOptions);
                                    if (gsi != null) GameStarted?.Invoke(gsi);
                                }
                                break;
                            case MessageType.MoveMsg:
                                if (msg.Data != null)
                                {
                                    var mm = JsonSerializer.Deserialize<MoveMessage>(msg.Data, _jsonOptions);
                                    if (mm != null) MoveReceived?.Invoke(mm);
                                }
                                break;
                            case MessageType.Resign:
                                ResignReceived?.Invoke();
                                break;
                            case MessageType.DrawOffer:
                                DrawOffered?.Invoke();
                                break;
                            case MessageType.DrawResponse:
                                if (msg.Data != null)
                                {
                                    var dr = JsonSerializer.Deserialize<DrawResponseMessage>(msg.Data, _jsonOptions);
                                    if (dr != null) DrawResponseReceived?.Invoke(dr.Accepted);
                                }
                                break;
                            case MessageType.ClockSync:
                                if (msg.Data != null)
                                {
                                    var cs = JsonSerializer.Deserialize<ClockSyncMessage>(msg.Data, _jsonOptions);
                                    if (cs != null) ClockSyncReceived?.Invoke(cs);
                                }
                                break;
                            case MessageType.SyncData:
                                if (msg.Data != null) SyncDataReceived?.Invoke(msg.Data);
                                break;
                            case MessageType.Rematch:
                                RematchRequested?.Invoke();
                                break;
                        }
                    }
                }
                catch (ObjectDisposedException) { Disconnected?.Invoke(); }
                catch (IOException) { Disconnected?.Invoke(); }
                catch { Disconnected?.Invoke(); }
            }, token);
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            _cts.Cancel();
            _writer?.Dispose();
            _reader?.Dispose();
            _pipeServer?.Dispose();
            _pipeClient?.Dispose();
            _cts.Dispose();
        }
    }
}
