using System;
using System.Drawing;
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
        private Label _pcNameLabel;
        private bool _isHosting;

        // Join tab
        private TextBox _hostPcNameTextBox;
        private Button _joinButton;
        private Label _joinStatusLabel;
        private Label _joinEloLabel;

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
            Size = new Size(500, 500);
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
                Size = new Size(464, 335),
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

            _pcNameLabel = new Label
            {
                Text = "",
                Location = new Point(30, 170),
                Size = new Size(400, 50),
                Font = new Font("Consolas", 14f, FontStyle.Bold),
                ForeColor = Color.FromArgb(52, 120, 200)
            };
            hostTab.Controls.Add(_pcNameLabel);

            _hostStatusLabel = new Label
            {
                Text = "",
                Location = new Point(30, 225),
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

            var hostNameLabel = new Label
            {
                Text = "Host PC Name:",
                Location = new Point(30, 70),
                AutoSize = true,
                Font = new Font("Segoe UI", 10f)
            };
            joinTab.Controls.Add(hostNameLabel);

            _hostPcNameTextBox = new TextBox
            {
                Location = new Point(170, 67),
                Width = 230,
                Font = new Font("Segoe UI", 10f),
                MaxLength = 50
            };
            joinTab.Controls.Add(_hostPcNameTextBox);

            _joinButton = new Button
            {
                Text = "Join",
                Location = new Point(30, 115),
                Size = new Size(150, 40),
                Font = new Font("Segoe UI", 11f, FontStyle.Bold),
                BackColor = Color.FromArgb(52, 120, 200),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            _joinButton.FlatAppearance.BorderSize = 0;
            _joinButton.Click += OnJoinClick;
            joinTab.Controls.Add(_joinButton);

            _joinStatusLabel = new Label
            {
                Text = "",
                Location = new Point(30, 170),
                Size = new Size(400, 25),
                Font = new Font("Segoe UI", 10f),
                ForeColor = Color.FromArgb(100, 100, 100)
            };
            joinTab.Controls.Add(_joinStatusLabel);

            _tabControl.TabPages.Add(joinTab);
            Controls.Add(_tabControl);
        }

        private void WireEvents()
        {
            _network.PlayerConnected += OnPlayerConnected;
            _network.GameStarted += OnGameStarted;
            _network.SyncDataReceived += OnSyncDataReceived;
            _network.Disconnected += OnDisconnected;
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
                _pcNameLabel.Text = "";
                _timeControlCombo.Enabled = true;
                return;
            }

            _playerData.Me.Name = _nameTextBox.Text.Trim();
            _playerData.Save();

            _network.StartHosting();
            _network.AcceptConnection();
            _isHosting = true;
            _hostButton.Text = "Stop Hosting";
            _hostButton.BackColor = Color.FromArgb(200, 60, 60);
            _timeControlCombo.Enabled = false;
            _pcNameLabel.Text = Environment.MachineName;
            _hostStatusLabel.Text = "Tell your opponent to enter this PC name and click Join.";
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

            string hostPcName = _hostPcNameTextBox.Text.Trim();
            if (string.IsNullOrEmpty(hostPcName))
            {
                MessageBox.Show("Enter the host's PC name.", "PC Name Required",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                _hostPcNameTextBox.Focus();
                return;
            }

            _playerData.Me.Name = _nameTextBox.Text.Trim();
            _playerData.Save();

            _connecting = true;
            _joinButton.Enabled = false;
            _joinStatusLabel.Text = "Connecting...";

            try
            {
                var myInfo = new PlayerInfo
                {
                    Id = _playerData.Me.Id,
                    Name = _playerData.Me.Name,
                    Elo = _playerData.Me.Elo
                };

                await _network.ConnectToHost(hostPcName, myInfo);
                _joinStatusLabel.Text = "Connected! Waiting for game start...";
                _network.SendSyncData(_playerData.SerializeForSync());
            }
            catch (TimeoutException)
            {
                _joinStatusLabel.Text = "Connection timed out. Check the PC name.";
                _connecting = false;
                _joinButton.Enabled = true;
            }
            catch (Exception ex)
            {
                _joinStatusLabel.Text = $"Failed: {ex.Message}";
                _connecting = false;
                _joinButton.Enabled = true;
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
                _network.StartHosting();
                _network.AcceptConnection();
            }
            else
            {
                _joinStatusLabel.Text = "Disconnected.";
                _connecting = false;
                _joinButton.Enabled = true;
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
                _pcNameLabel.Text = "";
                _joinStatusLabel.Text = "";
                _timeControlCombo.Enabled = true;
                _hostEloLabel.Text = $"Your Elo: {_playerData.Me.Elo}";
                _joinEloLabel.Text = $"Your Elo: {_playerData.Me.Elo}";

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
            _network?.Dispose();
            base.OnFormClosing(e);
        }
    }
}
