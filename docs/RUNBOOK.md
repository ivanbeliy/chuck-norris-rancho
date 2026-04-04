# Rancho Runbook

## Architecture

Rancho (chuck-norris-rancho) — infrastructure repository for deploying **Relay**, a Discord-to-Claude-Code transport layer.

```
Windows (this repo)              Mac Mini M1 (Tailscale VPN)
├── relay/                       ├── ~/relay/              (Relay bot)
├── infra/                       ├── ~/shared/             (Syncthing sync)
├── scripts/                     ├── ~/projects/           (dev projects)
└── docs/                        └── launchd: com.rancho.relay
```

Components on Mac Mini:
- **Relay** — Node.js Discord bot, spawns `claude -p` CLI sessions
- **Claude Code CLI** — AI agent, authorized via OAuth subscription
- **Syncthing** — file sync between Mac and Windows
- **Tailscale** — VPN for remote access
- **launchd** — auto-start service

## Connection

### Mac Mini (Tailscale VPN)

```bash
ssh rancho
```

SSH config (`~/.ssh/config`):
```
Host rancho
    HostName <TAILSCALE_IP>
    User i.beliy
    ServerAliveInterval 60
    ServerAliveCountMax 3
```

Setup: `bash scripts/setup-ssh.sh mac <TAILSCALE_IP>`

## Deployment

### Prerequisites (physically on Mac, ~12 min)

1. System Settings -> General -> Sharing -> **Remote Login** -> ON
2. System Settings -> Users & Groups -> **Automatic Login** -> select user
3. System Settings -> Energy Saver -> **Prevent sleep**, **Wake for network**, **Auto restart after power failure**
4. Install Homebrew: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`
5. Install Tailscale: `brew install --cask tailscale` -> log in -> `tailscale up --ssh`

### Automated Setup (via SSH)

```bash
scp infra/setup-mac.sh rancho:/tmp/
ssh rancho "sed -i '' 's/\r$//' /tmp/setup-mac.sh && bash /tmp/setup-mac.sh"
```

The script automatically:
- Configures energy settings
- Installs Node.js 22, Syncthing, Claude Code CLI
- Creates directories (~/relay, ~/shared, ~/projects)
- Sets up launchd service for Relay

### After setup-mac.sh

1. `ssh rancho "claude setup-token"` -> open URL in browser -> authorize -> paste code
2. Fill in Discord bot token: `ssh rancho "nano ~/relay/.env"`
3. Deploy Relay source: `bash scripts/deploy.sh`
4. Pair Syncthing: `ssh -L 8384:localhost:8384 rancho` -> http://localhost:8384
5. Test: `bash scripts/status.sh` -> send message in Discord
6. Reboot test: `ssh rancho "sudo shutdown -r now"` -> wait 3 min -> `bash scripts/status.sh`

## Discord Bot Setup

1. [Discord Developer Portal](https://discord.com/developers/applications) -> New Application
2. **Bot** tab:
   - Reset Token -> save as `DISCORD_BOT_TOKEN`
   - Privileged Gateway Intents:
     - **Message Content Intent** — required!
     - **Server Members Intent**
3. **OAuth2** -> URL Generator:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Read Message History`, `View Channels`, `Add Reactions`
   - Open URL -> add to server
4. Register projects: use `/project add` slash command in Discord

## Daily Operations

### Check status
```bash
bash scripts/status.sh
```

### View logs
```bash
bash scripts/logs.sh        # main logs
bash scripts/logs.sh error   # error logs only
```

### Restart Relay
```bash
bash scripts/restart.sh
```

### Deploy update
```bash
bash scripts/deploy.sh
```

### Register a new project
In Discord: `/project add <name> <path> <channel>`

Example: `/project add zbroya /Users/i.beliy/projects/zbroya.science #zbroya-science`

## Troubleshooting

### Relay not responding

1. Check service: `bash scripts/status.sh`
2. Check logs: `bash scripts/logs.sh error`
3. Restart: `bash scripts/restart.sh`

### Claude CLI errors

1. OAuth token expired: `ssh rancho "claude setup-token"`
2. After re-auth, restart Relay: `bash scripts/restart.sh`

### Session stuck in "running" state

Relay automatically resets stuck sessions on startup. To force:
```bash
bash scripts/restart.sh
```

Or manually: `ssh rancho "sqlite3 ~/relay/relay.db \"UPDATE sessions SET status='idle' WHERE status='running'\""`

### Bot connected but no messages received

**Message Content Intent** not enabled on Discord Developer Portal.
Bot tab -> Privileged Gateway Intents -> Message Content Intent -> Save.

### Mac Mini not reachable

1. Check Tailscale: `tailscale status` (from Windows)
2. Ping: `tailscale ping <mac-ip>`
3. If Mac not visible — physically check it's powered on and connected to network

### Mac Mini: Relay not starting after reboot

1. `ssh rancho "launchctl print gui/\$(id -u)/com.rancho.relay"`
2. Logs: `ssh rancho "tail -20 ~/relay/logs/relay.error.log"`
3. Manual start: `ssh rancho "cd ~/relay && node dist/index.js"`

## Maintenance

### Update Relay
```bash
bash scripts/deploy.sh
```

### Update Claude Code CLI
```bash
ssh rancho "npm install -g @anthropic-ai/claude-code"
bash scripts/restart.sh
```

### Backup database
```bash
ssh rancho "cp ~/relay/relay.db ~/relay/relay.db.bak"
```

## SSH Tunnel Cheat Sheet

```bash
# Syncthing GUI
ssh -L 8384:localhost:8384 rancho
```
