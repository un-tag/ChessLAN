using System;
using System.Collections.Concurrent;
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
        Rematch,
        Ack,
        Ping
    }

    public class NetMessage
    {
        public MessageType Type { get; set; }
        public string? Data { get; set; }
        public int Seq { get; set; }      // Sequence number for reliability
        public int AckSeq { get; set; }   // Acknowledging this seq
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
        public const int Port = 41234;

        private UdpClient? _udp;
        private IPEndPoint? _remoteEndpoint;
        private CancellationTokenSource _cts = new();
        private bool _disposed;
        private bool _connected;

        // Reliability layer
        private int _nextSeq = 1;
        private readonly ConcurrentDictionary<int, (byte[] Data, DateTime Sent, int Retries)> _unacked = new();
        private System.Threading.Timer? _retryTimer;

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

        // --- Host: wait for joiner to punch through ---

        public void StartHosting()
        {
            _cts = new CancellationTokenSource();
            _udp = new UdpClient();
            _udp.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            _udp.Client.Bind(new IPEndPoint(IPAddress.Any, Port));

            // Send a dummy outbound packet to open the firewall
            byte[] punch = Encoding.UTF8.GetBytes("punch");
            _udp.Send(punch, punch.Length, new IPEndPoint(IPAddress.Loopback, Port + 1));

            StartRetryTimer();
            StartReceiveLoop();
        }

        public void StopHosting()
        {
            _cts.Cancel();
            _retryTimer?.Dispose();
            _udp?.Close();
            _udp?.Dispose();
            _udp = null;
        }

        public void AcceptConnection()
        {
            // Host just waits for Connect message in receive loop
        }

        public void SendGameStart(GameStartInfo info)
        {
            SendReliable(MessageType.GameStart, info);
        }

        // --- Client: punch through to host ---

        public async Task ConnectToHost(string hostName, PlayerInfo myInfo)
        {
            _cts = new CancellationTokenSource();

            // Resolve host name to IP
            IPAddress[] addresses;
            try
            {
                addresses = await Dns.GetHostAddressesAsync(hostName);
            }
            catch
            {
                throw new Exception($"Could not resolve '{hostName}'");
            }

            var hostIp = Array.Find(addresses, a => a.AddressFamily == AddressFamily.InterNetwork)
                         ?? throw new Exception($"No IPv4 address found for '{hostName}'");

            _remoteEndpoint = new IPEndPoint(hostIp, Port);

            _udp = new UdpClient();
            _udp.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            _udp.Client.Bind(new IPEndPoint(IPAddress.Any, 0)); // Random local port

            // Send outbound to open firewall
            byte[] punch = Encoding.UTF8.GetBytes("punch");
            _udp.Send(punch, punch.Length, new IPEndPoint(IPAddress.Loopback, Port + 1));

            StartRetryTimer();
            StartReceiveLoop();

            // Send Connect message (reliable, will retry until ACKed)
            SendReliable(MessageType.Connect, myInfo);

            // Wait for connection to be acknowledged (up to 5 seconds)
            var deadline = DateTime.UtcNow.AddSeconds(5);
            while (!_connected && DateTime.UtcNow < deadline)
            {
                await Task.Delay(100, _cts.Token);
            }

            if (!_connected)
                throw new TimeoutException("Connection timed out. Check the PC name and make sure the host is waiting.");
        }

        // --- Shared send methods ---

        public void SendMove(MoveMessage move) => SendReliable(MessageType.MoveMsg, move);
        public void SendResign() => SendReliable(MessageType.Resign, (object?)null);
        public void SendDrawOffer() => SendReliable(MessageType.DrawOffer, (object?)null);
        public void SendDrawResponse(bool accepted) =>
            SendReliable(MessageType.DrawResponse, new DrawResponseMessage { Accepted = accepted });
        public void SendClockSync(double whiteMs, double blackMs) =>
            SendFire(MessageType.ClockSync, new ClockSyncMessage { WhiteTimeMs = whiteMs, BlackTimeMs = blackMs });
        public void SendSyncData(string jsonData) => SendReliable(MessageType.SyncData, jsonData);
        public void SendRematch() => SendReliable(MessageType.Rematch, (object?)null);

        // --- Reliability layer ---

        private void SendReliable<T>(MessageType type, T payload)
        {
            if (_udp == null || _remoteEndpoint == null) return;

            int seq = Interlocked.Increment(ref _nextSeq);

            string? data = payload != null
                ? (payload is string s ? s : JsonSerializer.Serialize(payload, _jsonOptions))
                : null;

            var msg = new NetMessage { Type = type, Data = data, Seq = seq };
            string json = JsonSerializer.Serialize(msg, _jsonOptions);
            byte[] bytes = Encoding.UTF8.GetBytes(json);

            _unacked[seq] = (bytes, DateTime.UtcNow, 0);

            try { _udp.Send(bytes, bytes.Length, _remoteEndpoint); }
            catch { }
        }

        // Fire-and-forget (for clock sync — high frequency, loss is OK)
        private void SendFire<T>(MessageType type, T payload)
        {
            if (_udp == null || _remoteEndpoint == null) return;

            string? data = payload != null
                ? (payload is string s ? s : JsonSerializer.Serialize(payload, _jsonOptions))
                : null;

            var msg = new NetMessage { Type = type, Data = data, Seq = 0 };
            string json = JsonSerializer.Serialize(msg, _jsonOptions);
            byte[] bytes = Encoding.UTF8.GetBytes(json);

            try { _udp.Send(bytes, bytes.Length, _remoteEndpoint); }
            catch { }
        }

        private void SendAck(int ackSeq)
        {
            if (_udp == null || _remoteEndpoint == null) return;

            var msg = new NetMessage { Type = MessageType.Ack, AckSeq = ackSeq };
            string json = JsonSerializer.Serialize(msg, _jsonOptions);
            byte[] bytes = Encoding.UTF8.GetBytes(json);

            try { _udp.Send(bytes, bytes.Length, _remoteEndpoint); }
            catch { }
        }

        private void StartRetryTimer()
        {
            _retryTimer = new System.Threading.Timer(_ =>
            {
                if (_disposed) return;
                var now = DateTime.UtcNow;
                foreach (var kvp in _unacked)
                {
                    var (data, sent, retries) = kvp.Value;
                    if ((now - sent).TotalMilliseconds > 200) // Retry after 200ms
                    {
                        if (retries > 50) // ~10 seconds of retries
                        {
                            _unacked.TryRemove(kvp.Key, out var _removed);
                            Disconnected?.Invoke();
                            return;
                        }

                        _unacked[kvp.Key] = (data, now, retries + 1);
                        try { _udp?.Send(data, data.Length, _remoteEndpoint); }
                        catch { }
                    }
                }
            }, null, 100, 100);
        }

        // --- Receive loop ---

        private void StartReceiveLoop()
        {
            var token = _cts.Token;
            Task.Run(async () =>
            {
                try
                {
                    while (!token.IsCancellationRequested && _udp != null)
                    {
                        UdpReceiveResult result;
                        try { result = await _udp.ReceiveAsync(token); }
                        catch (OperationCanceledException) { break; }
                        catch (ObjectDisposedException) { break; }
                        catch { continue; }

                        string json = Encoding.UTF8.GetString(result.Buffer);

                        // Ignore punch packets
                        if (json == "punch") continue;

                        NetMessage? msg;
                        try { msg = JsonSerializer.Deserialize<NetMessage>(json, _jsonOptions); }
                        catch { continue; }
                        if (msg == null) continue;

                        // Handle ACK
                        if (msg.Type == MessageType.Ack)
                        {
                            _unacked.TryRemove(msg.AckSeq, out _);
                            continue;
                        }

                        // Set remote endpoint from first real message (for host)
                        if (_remoteEndpoint == null)
                        {
                            _remoteEndpoint = result.RemoteEndPoint;
                        }

                        // Send ACK for reliable messages
                        if (msg.Seq > 0)
                        {
                            SendAck(msg.Seq);
                        }

                        // Dispatch
                        switch (msg.Type)
                        {
                            case MessageType.Connect:
                                if (msg.Data != null)
                                {
                                    var pi = JsonSerializer.Deserialize<PlayerInfo>(msg.Data, _jsonOptions);
                                    if (pi != null)
                                    {
                                        _connected = true;
                                        PlayerConnected?.Invoke(pi);
                                    }
                                }
                                break;
                            case MessageType.ConnectAck:
                                _connected = true;
                                break;
                            case MessageType.GameStart:
                                _connected = true;
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
                            case MessageType.Ping:
                                break;
                        }
                    }
                }
                catch (ObjectDisposedException) { }
                catch { Disconnected?.Invoke(); }
            }, token);
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            _cts.Cancel();
            _retryTimer?.Dispose();
            _udp?.Close();
            _udp?.Dispose();
            _cts.Dispose();
        }
    }
}
