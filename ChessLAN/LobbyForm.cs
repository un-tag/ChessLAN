using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
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
        private Button _joinButton;
        private Label _joinStatusLabel;
        private Label _joinEloLabel;

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
                _nameTextBox.Focus();
            else
                _nameTextBox.Text = _playerData.Me.Name;
        }

        private void InitializeUI()
        {
            Text = "ChessLAN";
            Size = new Size(500, 530);
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
                Size = new Size(464, 365),
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
                Location = new Point(30, 70),
                AutoSize = true,
                Font = new Font("Segoe UI", 10f)
            };
            hostTab.Controls.Add(tcLabel);

            _timeControlCombo = new ComboBox
            {
                Location = new Point(160, 67),
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
                Location = new Point(30, 115),
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
                Location = new Point(30, 175),
                Size = new Size(400, 25),
                Font = new Font("Segoe UI", 10f),
                ForeColor = Color.FromArgb(100, 100, 100)
            };
            hostTab.Controls.Add(_hostStatusLabel);

            _tabControl.TabPages.Add(hostTab);

            // === Join Tab ===
            var joinTab = new TabPage("Join Game");
            joinTab.Padding = new Padding(30, 20, 30, 20);

            _joinEloLabel = new Label
            {
                Text = $"Your Elo: {_playerData.Me.Elo}",
                Location = new Point(30, 25),
                AutoSize = true,
                Font = new Font("Segoe UI", 12f, FontStyle.Bold)
            };
            joinTab.Controls.Add(_joinEloLabel);

            var hostListLabel = new Label
            {
                Text = "Available Games:",
                Location = new Point(30, 60),
                AutoSize = true,
                Font = new Font("Segoe UI", 10f)
            };
            joinTab.Controls.Add(hostListLabel);

            _hostListBox = new ListBox
            {
                Location = new Point(30, 85),
                Size = new Size(400, 150),
                Font = new Font("Segoe UI", 10f)
            };
            _hostListBox.SelectedIndexChanged += (s, e) =>
            {
                _joinButton.Enabled = _hostListBox.SelectedIndex >= 0 && !_connecting;
            };
            _hostListBox.DoubleClick += (s, e) =>
            {
                if (_hostListBox.SelectedIndex >= 0 && !_connecting)
                    OnJoinClick(s, e);
            };
            joinTab.Controls.Add(_hostListBox);

            _joinButton = new Button
            {
                Text = "Join",
                Location = new Point(30, 245),
                Size = new Size(150, 40),
                Font = new Font("Segoe UI", 11f, FontStyle.Bold),
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
                Text = "Searching for games...",
                Location = new Point(195, 253),
                Size = new Size(250, 25),
                Font = new Font("Segoe UI", 9f),
                ForeColor = Color.FromArgb(130, 130, 130)
            };
            joinTab.Controls.Add(_joinStatusLabel);

            _tabControl.TabPages.Add(joinTab);
            Controls.Add(_tabControl);

            // Cleanup stale hosts every 3 seconds
            _cleanupTimer = new System.Windows.Forms.Timer { Interval = 3000 };
            _cleanupTimer.Tick += (s, e) => CleanupStaleHosts();
            _cleanupTimer.Start();

            // Start discovery on join tab select, and also on load
            _tabControl.SelectedIndexChanged += (s, e) =>
            {
                if (_tabControl.SelectedIndex == 1 && !_isHosting)
                    StartDiscovery();
            };
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

        private void StartDiscovery()
        {
            _discoveredHosts.Clear();
            RefreshHostList();
            try { _network.StartDiscovery(); } catch { }
        }

        private void OnHostDiscovered(HostInfo host, string senderIp)
        {
            if (InvokeRequired) { BeginInvoke(() => OnHostDiscovered(host, senderIp)); return; }

            // Don't show our own hosting
            if (host.Id == _playerData.Me.Id) return;

            _discoveredHosts[host.Id] = (host, senderIp, DateTime.UtcNow);
            RefreshHostList();
        }

        private void CleanupStaleHosts()
        {
            var now = DateTime.UtcNow;
            var stale = _discoveredHosts
                .Where(kvp => (now - kvp.Value.LastSeen).TotalSeconds > 5)
                .Select(kvp => kvp.Key)
                .ToList();

            if (stale.Count > 0)
            {
                foreach (var key in stale)
                    _discoveredHosts.Remove(key);
                RefreshHostList();
            }
        }

        private void RefreshHostList()
        {
            var selectedId = _hostListBox.SelectedIndex >= 0 ? GetHostIdAtIndex(_hostListBox.SelectedIndex) : null;

            _hostListBox.Items.Clear();
            foreach (var kvp in _discoveredHosts.OrderBy(h => h.Value.Info.Name))
            {
                var h = kvp.Value.Info;
                _hostListBox.Items.Add($"{h.Name} (Elo: {h.Elo}) - {h.TimeControl}");
            }

            if (selectedId != null)
            {
                int idx = 0;
                foreach (var kvp in _discoveredHosts.OrderBy(h => h.Value.Info.Name))
                {
                    if (kvp.Key == selectedId) { _hostListBox.SelectedIndex = idx; break; }
                    idx++;
                }
            }

            _joinButton.Enabled = _hostListBox.SelectedIndex >= 0 && !_connecting;
            _joinStatusLabel.Text = _discoveredHosts.Count == 0 ? "Searching for games..." : "";
        }

        private string? GetHostIdAtIndex(int index)
        {
            var ordered = _discoveredHosts.OrderBy(h => h.Value.Info.Name).ToList();
            return index >= 0 && index < ordered.Count ? ordered[index].Key : null;
        }

        private (HostInfo Info, string Ip)? GetSelectedHost()
        {
            int index = _hostListBox.SelectedIndex;
            var ordered = _discoveredHosts.OrderBy(h => h.Value.Info.Name).ToList();
            return index >= 0 && index < ordered.Count
                ? (ordered[index].Value.Info, ordered[index].Value.Ip)
                : null;
        }

        private void OnHostClick(object? sender, EventArgs e)
        {
            if (string.IsNullOrWhiteSpace(_nameTextBox.Text))
            {
                MessageBox.Show("Please enter your name first.", "Name Required",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                _nameTextBox.Focus();
                return;
            }

            if (_isHosting)
            {
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
                Port = NetworkManager.Port
            };

            _network.StopDiscovery();
            _network.StartHosting(hostInfo);
            _network.AcceptConnection();
            _isHosting = true;
            _hostButton.Text = "Stop Hosting";
            _hostButton.BackColor = Color.FromArgb(200, 60, 60);
            _timeControlCombo.Enabled = false;
            _hostStatusLabel.Text = "Waiting for opponent...";
        }

        private async void OnJoinClick(object? sender, EventArgs e)
        {
            if (_connecting) return;
            if (string.IsNullOrWhiteSpace(_nameTextBox.Text))
            {
                MessageBox.Show("Please enter your name first.", "Name Required",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                _nameTextBox.Focus();
                return;
            }

            var selected = GetSelectedHost();
            if (selected == null) return;

            var (hostInfo, hostIp) = selected.Value;

            _playerData.Me.Name = _nameTextBox.Text.Trim();
            _playerData.Save();

            _connecting = true;
            _joinButton.Enabled = false;
            _joinStatusLabel.Text = "Connecting...";

            try
            {
                _network.StopDiscovery();

                var myInfo = new PlayerInfo
                {
                    Id = _playerData.Me.Id,
                    Name = _playerData.Me.Name,
                    Elo = _playerData.Me.Elo
                };

                await _network.ConnectToHost(hostIp, myInfo);
                _joinStatusLabel.Text = "Connected! Starting game...";
                _network.SendSyncData(_playerData.SerializeForSync());
            }
            catch (TimeoutException)
            {
                _joinStatusLabel.Text = "Timed out. Try again.";
                _connecting = false;
                _joinButton.Enabled = _hostListBox.SelectedIndex >= 0;
                StartDiscovery();
            }
            catch (Exception ex)
            {
                _joinStatusLabel.Text = $"Failed: {ex.Message}";
                _connecting = false;
                _joinButton.Enabled = _hostListBox.SelectedIndex >= 0;
                StartDiscovery();
            }
        }

        private string? _pendingOpponentId;
        private string? _pendingOpponentName;
        private int _pendingOpponentElo;

        private void OnPlayerConnected(PlayerInfo player)
        {
            if (InvokeRequired) { BeginInvoke(() => OnPlayerConnected(player)); return; }

            _pendingOpponentId = player.Id;
            _pendingOpponentName = player.Name;
            _pendingOpponentElo = player.Elo;

            if (_isHosting)
            {
                _hostStatusLabel.Text = $"Connected: {player.Name} (Elo: {player.Elo})";
                _network.SendSyncData(_playerData.SerializeForSync());

                bool opponentPlaysWhite = new Random().Next(2) == 0;
                string timeControl = _timeControlCombo.SelectedItem?.ToString() ?? "5 min";

                _network.SendGameStart(new GameStartInfo
                {
                    YouPlayWhite = opponentPlaysWhite,
                    TimeControl = timeControl
                });

                PieceColor myColor = opponentPlaysWhite ? PieceColor.Black : PieceColor.White;
                LaunchGame(myColor, player.Id, player.Name, player.Elo, timeControl);
            }
        }

        private void OnGameStarted(GameStartInfo info)
        {
            if (InvokeRequired) { BeginInvoke(() => OnGameStarted(info)); return; }

            PieceColor myColor = info.YouPlayWhite ? PieceColor.White : PieceColor.Black;
            string opId = _pendingOpponentId ?? "";
            string opName = _pendingOpponentName ?? "Opponent";
            int opElo = _pendingOpponentElo;

            LaunchGame(myColor, opId, opName, opElo, info.TimeControl);
        }

        private void OnSyncDataReceived(string json)
        {
            if (InvokeRequired) { BeginInvoke(() => OnSyncDataReceived(json)); return; }

            var (isValid, tamperMessage) = _playerData.VerifyAndSync(json);
            if (!isValid && tamperMessage != null)
            {
                MessageBox.Show(
                    $"Warning: Data integrity issue detected.\n\n{tamperMessage}",
                    "Data Integrity Warning",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void OnDisconnected()
        {
            if (InvokeRequired) { BeginInvoke(OnDisconnected); return; }

            if (_isHosting)
            {
                _hostStatusLabel.Text = "Opponent disconnected. Waiting...";
                _network.Dispose();
                _network = new NetworkManager();
                WireEvents();
                string timeControl = _timeControlCombo.SelectedItem?.ToString() ?? "5 min";
                _network.StartHosting(new HostInfo
                {
                    Id = _playerData.Me.Id,
                    Name = _playerData.Me.Name,
                    Elo = _playerData.Me.Elo,
                    TimeControl = timeControl,
                    Port = NetworkManager.Port
                });
                _network.AcceptConnection();
            }
            else
            {
                _joinStatusLabel.Text = "Disconnected.";
                _connecting = false;
                _joinButton.Enabled = _hostListBox.SelectedIndex >= 0;
                StartDiscovery();
            }
        }

        private void LaunchGame(PieceColor myColor, string opponentId, string opponentName,
                                int opponentElo, string timeControl)
        {
            if (_isHosting)
            {
                _network.StopHosting();
                _isHosting = false;
            }

            var gameForm = new GameForm(_network, _playerData, myColor,
                opponentId, opponentName, opponentElo, timeControl);
            gameForm.FormClosed += (s, e) =>
            {
                _connecting = false;
                _hostButton.Text = "Host Game";
                _hostButton.BackColor = Color.FromArgb(76, 153, 76);
                _hostStatusLabel.Text = "";
                _joinStatusLabel.Text = "";
                _timeControlCombo.Enabled = true;
                _hostEloLabel.Text = $"Your Elo: {_playerData.Me.Elo}";
                _joinEloLabel.Text = $"Your Elo: {_playerData.Me.Elo}";

                _network.Dispose();
                _network = new NetworkManager();
                WireEvents();
                StartDiscovery();

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
            _network?.Dispose();
            base.OnFormClosing(e);
        }
    }
}
