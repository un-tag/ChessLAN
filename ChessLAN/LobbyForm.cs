using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Windows.Forms;

namespace ChessLAN
{
    public class LobbyForm : Form
    {
        private NetworkManager _network;
        private PlayerDataStore _playerData;

        private TextBox _nameTextBox;
        private TabControl _tabControl;

        // Host tab
        private ComboBox _timeControlCombo;
        private Button _hostButton;
        private Label _hostStatusLabel;
        private Label _hostEloLabel;
        private bool _isHosting;

        // Join tab
        private ListBox _hostListBox;
        private Button _refreshButton;
        private Button _joinButton;
        private Label _joinStatusLabel;

        private Dictionary<string, (HostInfo Info, string Ip, DateTime LastSeen)> _discoveredHosts = new();
        private System.Windows.Forms.Timer _cleanupTimer;
        private bool _connecting;

        public LobbyForm()
        {
            _playerData = new PlayerDataStore();
            _playerData.Load();
            _network = new NetworkManager();

            InitializeUI();
            WireEvents();

            if (string.IsNullOrWhiteSpace(_playerData.Me.Name))
            {
                _nameTextBox.Focus();
            }
            else
            {
                _nameTextBox.Text = _playerData.Me.Name;
            }
        }

        private void InitializeUI()
        {
            Text = "ChessLAN";
            Size = new Size(500, 600);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;

            // Title
            var titleLabel = new Label
            {
                Text = "ChessLAN",
                Font = new Font("Segoe UI", 28f, FontStyle.Bold),
                TextAlign = ContentAlignment.MiddleCenter,
                Location = new Point(0, 10),
                Size = new Size(484, 60),
                ForeColor = Color.FromArgb(50, 50, 50)
            };
            Controls.Add(titleLabel);

            // Name row
            var nameLabel = new Label
            {
                Text = "Your Name:",
                Location = new Point(20, 80),
                AutoSize = true,
                Font = new Font("Segoe UI", 10f)
            };
            Controls.Add(nameLabel);

            _nameTextBox = new TextBox
            {
                Location = new Point(120, 77),
                Width = 340,
                Font = new Font("Segoe UI", 10f),
                MaxLength = 30
            };
            _nameTextBox.TextChanged += (s, e) =>
            {
                _playerData.Me.Name = _nameTextBox.Text.Trim();
                _playerData.Save();
            };
            Controls.Add(_nameTextBox);

            // Tab control
            _tabControl = new TabControl
            {
                Location = new Point(10, 115),
                Size = new Size(464, 435),
                Font = new Font("Segoe UI", 10f),
                Padding = new Point(20, 8)
            };

            // === Host Tab ===
            var hostTab = new TabPage("Host Game");
            hostTab.Padding = new Padding(30, 20, 30, 20);

            _hostEloLabel = new Label
            {
                Text = $"Your Elo: {_playerData.Me.Elo}",
                Location = new Point(30, 25),
                AutoSize = true,
                Font = new Font("Segoe UI", 12f, FontStyle.Bold)
            };
            hostTab.Controls.Add(_hostEloLabel);

            var tcLabel = new Label
            {
                Text = "Time Control:",
                Location = new Point(30, 75),
                AutoSize = true,
                Font = new Font("Segoe UI", 10f)
            };
            hostTab.Controls.Add(tcLabel);

            _timeControlCombo = new ComboBox
            {
                Location = new Point(160, 72),
                Width = 200,
                DropDownStyle = ComboBoxStyle.DropDownList,
                Font = new Font("Segoe UI", 10f)
            };
            _timeControlCombo.Items.AddRange(new object[]
            {
                "1 min", "2 min", "3 min", "5 min", "10 min", "15 min", "30 min",
                "3+2", "5+3", "15+10"
            });
            _timeControlCombo.SelectedItem = "5 min";
            hostTab.Controls.Add(_timeControlCombo);

            _hostButton = new Button
            {
                Text = "Host Game",
                Location = new Point(30, 130),
                Size = new Size(150, 40),
                Font = new Font("Segoe UI", 11f, FontStyle.Bold),
                BackColor = Color.FromArgb(76, 153, 76),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            _hostButton.FlatAppearance.BorderSize = 0;
            _hostButton.Click += OnHostClick;
            hostTab.Controls.Add(_hostButton);

            _hostStatusLabel = new Label
            {
                Text = "",
                Location = new Point(30, 185),
                Size = new Size(400, 25),
                Font = new Font("Segoe UI", 10f),
                ForeColor = Color.FromArgb(100, 100, 100)
            };
            hostTab.Controls.Add(_hostStatusLabel);

            _tabControl.TabPages.Add(hostTab);

            // === Join Tab ===
            var joinTab = new TabPage("Join Game");
            joinTab.Padding = new Padding(30, 20, 30, 20);

            var hostListLabel = new Label
            {
                Text = "Available Hosts:",
                Location = new Point(30, 25),
                AutoSize = true,
                Font = new Font("Segoe UI", 10f)
            };
            joinTab.Controls.Add(hostListLabel);

            _hostListBox = new ListBox
            {
                Location = new Point(30, 50),
                Size = new Size(400, 230),
                Font = new Font("Segoe UI", 10f)
            };
            joinTab.Controls.Add(_hostListBox);

            _refreshButton = new Button
            {
                Text = "Refresh",
                Location = new Point(30, 295),
                Size = new Size(100, 35),
                Font = new Font("Segoe UI", 10f)
            };
            _refreshButton.Click += OnRefreshClick;
            joinTab.Controls.Add(_refreshButton);

            _joinButton = new Button
            {
                Text = "Join",
                Location = new Point(145, 295),
                Size = new Size(100, 35),
                Font = new Font("Segoe UI", 10f, FontStyle.Bold),
                BackColor = Color.FromArgb(52, 120, 200),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Enabled = false
            };
            _joinButton.FlatAppearance.BorderSize = 0;
            _joinButton.Click += OnJoinClick;
            joinTab.Controls.Add(_joinButton);

            _joinStatusLabel = new Label
            {
                Text = "",
                Location = new Point(30, 345),
                Size = new Size(400, 25),
                Font = new Font("Segoe UI", 10f),
                ForeColor = Color.FromArgb(100, 100, 100)
            };
            joinTab.Controls.Add(_joinStatusLabel);

            _hostListBox.SelectedIndexChanged += (s, e) =>
            {
                _joinButton.Enabled = _hostListBox.SelectedIndex >= 0;
            };

            _tabControl.TabPages.Add(joinTab);
            Controls.Add(_tabControl);

            // Cleanup timer to remove stale hosts
            _cleanupTimer = new System.Windows.Forms.Timer { Interval = 3000 };
            _cleanupTimer.Tick += (s, e) => CleanupStaleHosts();
            _cleanupTimer.Start();

            // Start discovery when join tab is selected, and also on load
            _tabControl.SelectedIndexChanged += (s, e) =>
            {
                if (_tabControl.SelectedIndex == 1 && !_isHosting)
                {
                    StartDiscovery();
                }
            };

            // Auto-start discovery on load so hosts are found immediately
            Load += (s, e) => StartDiscovery();
        }

        private void WireEvents()
        {
            _network.HostDiscovered += OnHostDiscovered;
            _network.PlayerConnected += OnPlayerConnected;
            _network.GameStarted += OnGameStarted;
            _network.SyncDataReceived += OnSyncDataReceived;
            _network.Disconnected += OnDisconnected;
        }

        private void OnHostClick(object? sender, EventArgs e)
        {
            if (string.IsNullOrWhiteSpace(_nameTextBox.Text))
            {
                MessageBox.Show("Please enter your name first.", "Name Required", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                _nameTextBox.Focus();
                return;
            }

            if (_isHosting)
            {
                // Stop hosting
                _network.StopHosting();
                _isHosting = false;
                _hostButton.Text = "Host Game";
                _hostButton.BackColor = Color.FromArgb(76, 153, 76);
                _hostStatusLabel.Text = "";
                _timeControlCombo.Enabled = true;
                return;
            }

            _playerData.Me.Name = _nameTextBox.Text.Trim();
            _playerData.Save();

            string timeControl = _timeControlCombo.SelectedItem?.ToString() ?? "5 min";

            var hostInfo = new HostInfo
            {
                Id = _playerData.Me.Id,
                Name = _playerData.Me.Name,
                Elo = _playerData.Me.Elo,
                TimeControl = timeControl,
                Port = NetworkManager.DefaultTcpPort
            };

            _network.StartHosting(hostInfo);
            _network.AcceptConnection();
            _isHosting = true;
            _hostButton.Text = "Stop Hosting";
            _hostButton.BackColor = Color.FromArgb(200, 60, 60);
            _hostStatusLabel.Text = "Waiting for opponent...";
            _timeControlCombo.Enabled = false;
        }

        private void OnHostDiscovered(HostInfo host)
        {
            if (InvokeRequired)
            {
                BeginInvoke(() => OnHostDiscovered(host));
                return;
            }

            // Get the IP from the UDP receive -- we store it keyed by host Id
            // The NetworkManager fires HostDiscovered but doesn't give us the IP directly.
            // We need to get it from somewhere. For now we'll use a workaround:
            // Store with a placeholder; the actual IP comes from the UDP endpoint.
            // Since we can't modify NetworkManager, we'll store the host info and
            // attempt connection to broadcast addresses. Actually, let's get the sender IP
            // by examining the host info -- we need to add IP tracking.

            // Store/update the host
            string key = host.Id;
            string ip = ""; // We'll resolve this differently

            // The HostInfo doesn't include IP, but in LAN the host broadcasts.
            // We need to discover the IP. Let's use a workaround: store the host
            // and when joining, we'll need the IP. For UDP broadcast reception,
            // the source IP is available at the UdpClient level but NetworkManager
            // doesn't expose it. We'll store hosts and get IP via DNS/broadcast.
            //
            // Practical approach: We'll store hosts keyed by Id. For the IP,
            // we'll just try connecting to all LAN IPs or use the fact that
            // in most LAN setups, the host port is enough if we get the endpoint.
            //
            // Since NetworkManager.HostDiscovered only gives HostInfo, we'll
            // attach extra info by hooking at a lower level or storing endpoint info.
            // For simplicity, let's assume the host IP can be derived or we modify
            // our discovery approach.

            // Actually, re-examining the UDP listener in NetworkManager, the source
            // IP is in result.RemoteEndPoint but not forwarded. We'll work around
            // this by making the host include its local IP or by using a parallel
            // UDP listener. For now, let's add a simple parallel UDP listener.

            if (!_discoveredHosts.ContainsKey(key) || _discoveredHosts[key].Info.Elo != host.Elo)
            {
                _discoveredHosts[key] = (host, "", DateTime.UtcNow);
            }
            else
            {
                var existing = _discoveredHosts[key];
                _discoveredHosts[key] = (host, existing.Ip, DateTime.UtcNow);
            }

            RefreshHostList();
        }

        private void StartDiscovery()
        {
            try
            {
                _network.StopDiscovery();
            }
            catch { }

            _discoveredHosts.Clear();
            RefreshHostList();

            // Start a parallel UDP listener to capture source IPs
            StartIpCapturingDiscovery();
        }

        private UdpClient? _ipDiscoveryClient;

        private void StartIpCapturingDiscovery()
        {
            _ipDiscoveryClient?.Close();
            _ipDiscoveryClient?.Dispose();

            try
            {
                _ipDiscoveryClient = new UdpClient();
                _ipDiscoveryClient.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                _ipDiscoveryClient.Client.Bind(new IPEndPoint(IPAddress.Any, NetworkManager.UdpPort));
                _ipDiscoveryClient.EnableBroadcast = true;

                System.Threading.Tasks.Task.Run(async () =>
                {
                    try
                    {
                        while (_ipDiscoveryClient != null)
                        {
                            var result = await _ipDiscoveryClient.ReceiveAsync();
                            string json = System.Text.Encoding.UTF8.GetString(result.Buffer);
                            string sourceIp = result.RemoteEndPoint.Address.ToString();

                            try
                            {
                                var msg = System.Text.Json.JsonSerializer.Deserialize<NetMessage>(json, new System.Text.Json.JsonSerializerOptions { PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase });
                                if (msg?.Type == MessageType.HostAnnounce && msg.Data != null)
                                {
                                    var hostInfo = System.Text.Json.JsonSerializer.Deserialize<HostInfo>(msg.Data, new System.Text.Json.JsonSerializerOptions { PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase });
                                    if (hostInfo != null && hostInfo.Id != _playerData.Me.Id)
                                    {
                                        BeginInvoke(() =>
                                        {
                                            _discoveredHosts[hostInfo.Id] = (hostInfo, sourceIp, DateTime.UtcNow);
                                            RefreshHostList();
                                        });
                                    }
                                }
                            }
                            catch { }
                        }
                    }
                    catch (ObjectDisposedException) { }
                    catch { }
                });
            }
            catch { }
        }

        private void CleanupStaleHosts()
        {
            var now = DateTime.UtcNow;
            var staleKeys = _discoveredHosts
                .Where(kvp => (now - kvp.Value.LastSeen).TotalSeconds > 5)
                .Select(kvp => kvp.Key)
                .ToList();

            if (staleKeys.Count > 0)
            {
                foreach (var key in staleKeys)
                    _discoveredHosts.Remove(key);
                RefreshHostList();
            }
        }

        private void RefreshHostList()
        {
            if (InvokeRequired)
            {
                BeginInvoke(RefreshHostList);
                return;
            }

            var selectedId = _hostListBox.SelectedIndex >= 0 && _hostListBox.SelectedIndex < _hostListBox.Items.Count
                ? GetHostIdAtIndex(_hostListBox.SelectedIndex)
                : null;

            _hostListBox.Items.Clear();
            foreach (var kvp in _discoveredHosts.OrderBy(h => h.Value.Info.Name))
            {
                var h = kvp.Value.Info;
                _hostListBox.Items.Add($"{h.Name} (Elo: {h.Elo}) - {h.TimeControl}");
            }

            // Restore selection
            if (selectedId != null)
            {
                int idx = 0;
                foreach (var kvp in _discoveredHosts.OrderBy(h => h.Value.Info.Name))
                {
                    if (kvp.Key == selectedId)
                    {
                        _hostListBox.SelectedIndex = idx;
                        break;
                    }
                    idx++;
                }
            }

            _joinButton.Enabled = _hostListBox.SelectedIndex >= 0;
        }

        private string? GetHostIdAtIndex(int index)
        {
            var ordered = _discoveredHosts.OrderBy(h => h.Value.Info.Name).ToList();
            if (index >= 0 && index < ordered.Count)
                return ordered[index].Key;
            return null;
        }

        private (HostInfo Info, string Ip)? GetSelectedHost()
        {
            int index = _hostListBox.SelectedIndex;
            var ordered = _discoveredHosts.OrderBy(h => h.Value.Info.Name).ToList();
            if (index >= 0 && index < ordered.Count)
                return (ordered[index].Value.Info, ordered[index].Value.Ip);
            return null;
        }

        private void OnRefreshClick(object? sender, EventArgs e)
        {
            StartDiscovery();
        }

        private async void OnJoinClick(object? sender, EventArgs e)
        {
            if (_connecting) return;
            if (string.IsNullOrWhiteSpace(_nameTextBox.Text))
            {
                MessageBox.Show("Please enter your name first.", "Name Required", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                _nameTextBox.Focus();
                return;
            }

            var selected = GetSelectedHost();
            if (selected == null) return;

            var (hostInfo, hostIp) = selected.Value;

            if (string.IsNullOrEmpty(hostIp))
            {
                MessageBox.Show("Could not determine host IP address. Try refreshing.", "Connection Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            _playerData.Me.Name = _nameTextBox.Text.Trim();
            _playerData.Save();

            _connecting = true;
            _joinButton.Enabled = false;
            _joinStatusLabel.Text = "Connecting...";

            try
            {
                // Stop IP discovery before connecting (port conflict)
                _ipDiscoveryClient?.Close();
                _ipDiscoveryClient?.Dispose();
                _ipDiscoveryClient = null;

                var myInfo = new PlayerInfo
                {
                    Id = _playerData.Me.Id,
                    Name = _playerData.Me.Name,
                    Elo = _playerData.Me.Elo
                };

                await _network.ConnectToHost(hostIp, hostInfo.Port, myInfo);
                _joinStatusLabel.Text = "Connected! Waiting for game start...";

                // Send sync data
                _network.SendSyncData(_playerData.SerializeForSync());
            }
            catch (Exception ex)
            {
                _joinStatusLabel.Text = $"Connection failed: {ex.Message}";
                _connecting = false;
                _joinButton.Enabled = true;
            }
        }

        private string? _pendingOpponentId;
        private string? _pendingOpponentName;
        private int _pendingOpponentElo;

        private void OnPlayerConnected(PlayerInfo player)
        {
            if (InvokeRequired)
            {
                BeginInvoke(() => OnPlayerConnected(player));
                return;
            }

            _pendingOpponentId = player.Id;
            _pendingOpponentName = player.Name;
            _pendingOpponentElo = player.Elo;

            if (_isHosting)
            {
                _hostStatusLabel.Text = $"Connected: {player.Name} (Elo: {player.Elo})";

                // Send sync data
                _network.SendSyncData(_playerData.SerializeForSync());

                // Decide colors randomly
                bool opponentPlaysWhite = new Random().Next(2) == 0;
                string timeControl = _timeControlCombo.SelectedItem?.ToString() ?? "5 min";

                // Send game start to opponent
                _network.SendGameStart(new GameStartInfo
                {
                    YouPlayWhite = opponentPlaysWhite,
                    TimeControl = timeControl
                });

                // Launch game form
                PieceColor myColor = opponentPlaysWhite ? PieceColor.Black : PieceColor.White;
                LaunchGame(myColor, player.Id, player.Name, player.Elo, timeControl);
            }
        }

        private void OnGameStarted(GameStartInfo info)
        {
            if (InvokeRequired)
            {
                BeginInvoke(() => OnGameStarted(info));
                return;
            }

            PieceColor myColor = info.YouPlayWhite ? PieceColor.White : PieceColor.Black;
            string opId = _pendingOpponentId ?? "";
            string opName = _pendingOpponentName ?? "Opponent";
            int opElo = _pendingOpponentElo;

            // If we don't have opponent info yet (joined as client), use host info
            if (string.IsNullOrEmpty(opId))
            {
                var selected = GetSelectedHost();
                if (selected != null)
                {
                    opId = selected.Value.Info.Id;
                    opName = selected.Value.Info.Name;
                    opElo = selected.Value.Info.Elo;
                }
            }

            LaunchGame(myColor, opId, opName, opElo, info.TimeControl);
        }

        private void OnSyncDataReceived(string json)
        {
            if (InvokeRequired)
            {
                BeginInvoke(() => OnSyncDataReceived(json));
                return;
            }

            var (isValid, tamperMessage) = _playerData.VerifyAndSync(json);
            if (!isValid && tamperMessage != null)
            {
                MessageBox.Show(
                    $"Warning: Data integrity issue detected.\n\n{tamperMessage}\n\nThe game will continue, but results may be unreliable.",
                    "Data Integrity Warning",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning
                );
            }
        }

        private void OnDisconnected()
        {
            if (InvokeRequired)
            {
                BeginInvoke(OnDisconnected);
                return;
            }

            if (_isHosting)
            {
                _hostStatusLabel.Text = "Opponent disconnected. Waiting for new opponent...";
                _network.AcceptConnection();
            }
            else
            {
                _joinStatusLabel.Text = "Disconnected from host.";
                _connecting = false;
                _joinButton.Enabled = _hostListBox.SelectedIndex >= 0;
            }
        }

        private void LaunchGame(PieceColor myColor, string opponentId, string opponentName, int opponentElo, string timeControl)
        {
            // Stop hosting/discovery
            if (_isHosting)
            {
                _network.StopHosting();
                _isHosting = false;
            }
            _ipDiscoveryClient?.Close();
            _ipDiscoveryClient?.Dispose();
            _ipDiscoveryClient = null;

            var gameForm = new GameForm(_network, _playerData, myColor, opponentId, opponentName, opponentElo, timeControl);
            gameForm.FormClosed += (s, e) =>
            {
                // Reset state
                _connecting = false;
                _hostButton.Text = "Host Game";
                _hostButton.BackColor = Color.FromArgb(76, 153, 76);
                _hostStatusLabel.Text = "";
                _joinStatusLabel.Text = "";
                _timeControlCombo.Enabled = true;
                _hostEloLabel.Text = $"Your Elo: {_playerData.Me.Elo}";

                // Create fresh network manager
                _network.Dispose();
                _network = new NetworkManager();
                WireEvents();

                Show();
            };

            Hide();
            gameForm.Show();
            SoundManager.PlayGameStart();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            _cleanupTimer?.Stop();
            _cleanupTimer?.Dispose();
            _ipDiscoveryClient?.Close();
            _ipDiscoveryClient?.Dispose();
            _network?.Dispose();
            base.OnFormClosing(e);
        }
    }
}
