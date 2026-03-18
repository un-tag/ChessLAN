using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
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
        public const int UdpPort = 41234;
        public const int DefaultTcpPort = 41235;

        private UdpClient? _udpBroadcaster;
        private TcpListener? _tcpListener;
        private TcpClient? _tcpClient;
        private StreamReader? _reader;
        private StreamWriter? _writer;
        private CancellationTokenSource _cts = new();
        private bool _disposed;

        private static readonly JsonSerializerOptions _jsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        };

        // Events
        public event Action<HostInfo, string>? HostDiscovered;
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

        public void StartHosting(HostInfo hostInfo)
        {
            _cts = new CancellationTokenSource();

            // Start TCP listener
            _tcpListener = new TcpListener(IPAddress.Any, hostInfo.Port);
            _tcpListener.Start();

            // Start UDP broadcast
            _udpBroadcaster = new UdpClient();
            _udpBroadcaster.EnableBroadcast = true;

            var token = _cts.Token;
            Task.Run(async () =>
            {
                var endpoint = new IPEndPoint(IPAddress.Broadcast, UdpPort);
                while (!token.IsCancellationRequested)
                {
                    try
                    {
                        var msg = new NetMessage
                        {
                            Type = MessageType.HostAnnounce,
                            Data = JsonSerializer.Serialize(hostInfo, _jsonOptions)
                        };
                        string json = JsonSerializer.Serialize(msg, _jsonOptions);
                        byte[] bytes = Encoding.UTF8.GetBytes(json);
                        await _udpBroadcaster.SendAsync(bytes, bytes.Length, endpoint);
                        await Task.Delay(1000, token);
                    }
                    catch (OperationCanceledException) { break; }
                    catch { }
                }
            }, token);
        }

        public void StopHosting()
        {
            _udpBroadcaster?.Close();
            _udpBroadcaster?.Dispose();
            _udpBroadcaster = null;
            _tcpListener?.Stop();
            _tcpListener = null;
        }

        public void AcceptConnection()
        {
            if (_tcpListener == null) return;
            var token = _cts.Token;
            Task.Run(async () =>
            {
                try
                {
                    _tcpClient = await _tcpListener.AcceptTcpClientAsync(token);
                    _tcpClient.NoDelay = true;
                    var stream = _tcpClient.GetStream();
                    _reader = new StreamReader(stream, Encoding.UTF8);
                    _writer = new StreamWriter(stream, Encoding.UTF8) { AutoFlush = true };

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

        public void SendGameStart(GameStartInfo info) => SendMessage(MessageType.GameStart, info);

        // --- Discovery (joiner listens for UDP broadcasts) ---

        private UdpClient? _udpListener;

        public void StartDiscovery()
        {
            _udpListener?.Close();
            _udpListener?.Dispose();

            _udpListener = new UdpClient();
            _udpListener.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            _udpListener.Client.Bind(new IPEndPoint(IPAddress.Any, UdpPort));
            _udpListener.EnableBroadcast = true;

            var token = _cts.Token;
            Task.Run(async () =>
            {
                while (!token.IsCancellationRequested)
                {
                    try
                    {
                        var result = await _udpListener.ReceiveAsync(token);
                        string json = Encoding.UTF8.GetString(result.Buffer);
                        var msg = JsonSerializer.Deserialize<NetMessage>(json, _jsonOptions);
                        if (msg?.Type == MessageType.HostAnnounce && msg.Data != null)
                        {
                            var hostInfo = JsonSerializer.Deserialize<HostInfo>(msg.Data, _jsonOptions);
                            if (hostInfo != null)
                            {
                                string senderIp = result.RemoteEndPoint.Address.ToString();
                                HostDiscovered?.Invoke(hostInfo, senderIp);
                            }
                        }
                    }
                    catch (OperationCanceledException) { break; }
                    catch (ObjectDisposedException) { break; }
                    catch { }
                }
            }, token);
        }

        public void StopDiscovery()
        {
            _udpListener?.Close();
            _udpListener?.Dispose();
            _udpListener = null;
        }

        // --- Client Methods ---

        public async Task ConnectToHost(string hostIp, PlayerInfo myInfo)
        {
            _tcpClient = new TcpClient();
            _tcpClient.NoDelay = true;
            await _tcpClient.ConnectAsync(IPAddress.Parse(hostIp), DefaultTcpPort);

            var stream = _tcpClient.GetStream();
            _reader = new StreamReader(stream, Encoding.UTF8);
            _writer = new StreamWriter(stream, Encoding.UTF8) { AutoFlush = true };

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
            _udpBroadcaster?.Close();
            _udpBroadcaster?.Dispose();
            _udpListener?.Close();
            _udpListener?.Dispose();
            _writer?.Dispose();
            _reader?.Dispose();
            _tcpClient?.Close();
            _tcpClient?.Dispose();
            _tcpListener?.Stop();
            _cts.Dispose();
        }
    }
}
