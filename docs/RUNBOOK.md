# WhiteClaw Runbook

## Архітектура

WhiteClaw — інфраструктурний репозиторій для розгортання [NanoClaw](https://github.com/qwibitai/nanoclaw) AI-асистента на DigitalOcean VM з Discord-інтеграцією.

```
Windows (цей репо)              DigitalOcean VM (164.90.233.82)
├── infra/                      ├── /root/nanoclaw/          (NanoClaw + Discord)
├── config/                     ├── /root/shared/            (Syncthing sync)
├── scripts/                    ├── /root/projects/          (dev projects)
└── docs/                       └── systemd: nanoclaw.service
```

Компоненти на VM:
- **NanoClaw** — оркестратор, приймає повідомлення з Discord, запускає Claude агентів у Docker-контейнерах
- **Docker** — ізоляція агентів (`nanoclaw-agent:latest` image)
- **Syncthing** — синхронізація файлів між VM та Windows
- **Claude Code CLI** — для інтерактивного налаштування (`/setup`, `/add-discord`)

## Підключення

SSH працює на порту **443** (порт 22 блокується ISP):
```bash
ssh whiteclaw
```

Конфіг SSH (`~/.ssh/config`):
```
Host whiteclaw
    HostName 164.90.233.82
    Port 443
    User root
    IdentityFile ~/.ssh/whiteclaw_ed25519
    ServerAliveInterval 60
    ServerAliveCountMax 3
```

## Розгортання з нуля

### 1. Створити дроплет + фаєрвол
```bash
bash infra/provision-droplet.sh
bash infra/firewall.sh
```

### 2. Налаштувати SSH на порт 443

Через DigitalOcean Console (бо порт 22 може бути заблокований ISP):
```bash
echo "Port 443" >> /etc/ssh/sshd_config
mkdir -p /run/sshd
systemctl restart ssh.socket 2>/dev/null || systemctl restart ssh.service
```

Потім з Windows: `bash scripts/setup-ssh.sh <DROPLET_IP>`

### 3. Провізіонувати VM
```bash
scp infra/setup-vm.sh whiteclaw:/tmp/
ssh whiteclaw "sed -i 's/\r$//' /tmp/setup-vm.sh && bash /tmp/setup-vm.sh"
```

### 4. Розгорнути NanoClaw
```bash
ssh whiteclaw
git clone https://github.com/qwibitai/nanoclaw.git /root/nanoclaw
cd /root/nanoclaw

# Конфігурація git (для merge операцій)
git config user.email "whiteclaw@vm"
git config user.name "WhiteClaw"

# Збірка
npm install && npm run build
```

### 5. Додати Discord канал
```bash
cd /root/nanoclaw

# Merge Discord-коду
git remote add discord https://github.com/qwibitai/nanoclaw-discord.git
git fetch discord main
git merge discord/main --no-edit
npm install && npm run build
```

### 6. OAuth-токен Claude

Запустити **на VM** інтерактивно:
```bash
claude setup-token
```
Відкрити URL у браузері → авторизуватись → вставити код у термінал.

### 7. Створити .env
```bash
cat > /root/nanoclaw/.env << 'EOF'
CLAUDE_CODE_OAUTH_TOKEN=<токен з claude setup-token>
DISCORD_BOT_TOKEN=<токен з Discord Developer Portal>
ASSISTANT_NAME=WhiteClaw
ASSISTANT_HAS_OWN_NUMBER=true
TZ=Europe/Kyiv
MAX_CONCURRENT_CONTAINERS=2
EOF

mkdir -p data/env && cp .env data/env/env
```

### 8. Скопіювати конфіги агента
```bash
# З Windows:
scp config/agent-claude.md whiteclaw:/root/.config/nanoclaw/agent-claude.md
scp config/global-claude.md whiteclaw:/root/.config/nanoclaw/global-claude.md
scp config/mount-allowlist.json whiteclaw:/root/.config/nanoclaw/mount-allowlist.json
```

### 9. Збудувати Docker-образ
```bash
ssh whiteclaw "cd /root/nanoclaw/container && bash build.sh"
```

### 10. Підготувати session data

NanoClaw монтує session-директорію в контейнер як `/home/node/.claude` та `/app/src`.
Контейнер працює під uid 1000 (node), тому потрібні правильні permissions:

```bash
# Створити директорії для кожного зареєстрованого каналу
GROUP_FOLDER="discord_main"
mkdir -p /root/nanoclaw/data/sessions/${GROUP_FOLDER}/.claude/debug
mkdir -p /root/nanoclaw/data/sessions/${GROUP_FOLDER}/agent-runner-src

# Скопіювати вихідники agent-runner (контейнер монтує /app/src з хоста)
cp -r /root/nanoclaw/container/agent-runner/src/* \
      /root/nanoclaw/data/sessions/${GROUP_FOLDER}/agent-runner-src/

# Встановити правильного власника (uid 1000 = node user в контейнері)
chown -R 1000:1000 /root/nanoclaw/data/sessions/${GROUP_FOLDER}
```

### 11. Зареєструвати Discord-канал
```bash
cd /root/nanoclaw && node -e "
const db = require('./dist/db.js');
db.initDatabase();
db.setRegisteredGroup('dc:<CHANNEL_ID>', {
  name: 'WhiteClaw Main',
  folder: 'discord_main',
  trigger: '@WhiteClaw',
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true
});
console.log(JSON.stringify(db.getAllRegisteredGroups(), null, 2));
"
```

### 12. Створити та запустити systemd сервіс
```bash
cp /path/to/infra/nanoclaw.service /etc/systemd/system/nanoclaw.service
systemctl daemon-reload
systemctl enable nanoclaw
systemctl start nanoclaw
```

### 13. Перевірити
```bash
tail -f /root/nanoclaw/logs/nanoclaw.log
```
Надіслати повідомлення в Discord → бот має відповісти.

## Discord Bot Setup

1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application
2. **Bot** tab:
   - Reset Token → зберегти `DISCORD_BOT_TOKEN`
   - Privileged Gateway Intents:
     - **Message Content Intent** — обов'язково!
     - **Server Members Intent**
3. **OAuth2** → URL Generator:
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Read Message History`, `View Channels`
   - Відкрити URL → додати на сервер
4. У Discord: User Settings → Advanced → Developer Mode → ПКМ на канал → Copy Channel ID

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

### Restart NanoClaw
```bash
bash scripts/restart.sh
```

## Troubleshooting

### SSH connection timeout
ISP блокує порт 22. VM слухає SSH на двох портах:
- Порт 22 (стандартний)
- Порт 443 (fallback, рекомендований)

Якщо обидва не працюють — використати [DigitalOcean Console](https://cloud.digitalocean.com/droplets).

**НІКОЛИ** не вбивати sshd вручну (`kill $(pgrep sshd)`). Використовувати тільки `systemctl restart ssh.socket`.

### Agent not responding
1. Check service: `ssh whiteclaw "systemctl status nanoclaw"`
2. Check logs: `bash scripts/logs.sh error`
3. Check containers: `ssh whiteclaw "docker ps"`
4. Restart: `bash scripts/restart.sh`

### Container exited with code 1 — "Claude Code process exited with code 1"
- OAuth-токен протухнув → `claude setup-token` на VM, оновити `.env`, `cp .env data/env/env`, `systemctl restart nanoclaw`
- Стара сесія зламана → `sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder='discord_main';"` + видалити `/root/nanoclaw/data/sessions/discord_main`, створити заново (крок 10)

### Container exited with code 2 — "TS18003: No inputs were found"
`/app/src` монтується з хоста і порожня. Виправити:
```bash
cp -r /root/nanoclaw/container/agent-runner/src/* \
      /root/nanoclaw/data/sessions/discord_main/agent-runner-src/
chown -R 1000:1000 /root/nanoclaw/data/sessions/discord_main/agent-runner-src/
```

### Bot typing but not responding (IPC permissions)
NanoClaw під root створює IPC-файли, контейнер під node (uid 1000) не може їх прочитати.
Systemd сервіс має мати `UMask=0000`. Перевірити: `grep UMask /etc/systemd/system/nanoclaw.service`.

### Bot connected but no messages received
**Message Content Intent** не увімкнений на Discord Developer Portal.
Bot tab → Privileged Gateway Intents → Message Content Intent → Save.
Може знадобитися перезапросити бота на сервер.

### Container OOM / slow
1. Check running containers: `ssh whiteclaw "docker ps"`
2. Check memory: `ssh whiteclaw "free -h"`
3. Kill stuck containers: `ssh whiteclaw "docker kill \$(docker ps -q)"`
4. Reduce concurrency: edit `/root/nanoclaw/.env` → `MAX_CONCURRENT_CONTAINERS=1`

### Syncthing not syncing
1. Check service: `ssh whiteclaw "systemctl status syncthing@root"`
2. Check GUI via tunnel: `ssh -L 8384:localhost:8384 whiteclaw` → open `http://localhost:8384`
3. Verify device is connected in Syncthing GUI
4. Check firewall: ports 22000 (TCP/UDP) and 21027 (UDP)

### OAuth token expired
1. SSH into VM: `ssh whiteclaw`
2. `claude setup-token` (відкрити URL в браузері, авторизуватись, вставити код)
3. Скопіювати токен в `/root/nanoclaw/.env`
4. `cp .env data/env/env && systemctl restart nanoclaw`

## Maintenance

### Update NanoClaw
```bash
bash scripts/deploy.sh
```

### Create backup snapshot
```bash
bash scripts/snapshot.sh
```

### Update VM packages
```bash
ssh whiteclaw "apt update && DEBIAN_FRONTEND=noninteractive apt upgrade -y"
```

### Rebuild Docker image (after NanoClaw update)
```bash
ssh whiteclaw "cd /root/nanoclaw/container && bash build.sh"
```

### Lock down Syncthing GUI (after pairing)
```bash
ssh whiteclaw "sed -i 's|0.0.0.0:8384|127.0.0.1:8384|' /root/.config/syncthing/config.xml && systemctl restart syncthing@root"
```
Access via SSH tunnel: `ssh -L 8384:localhost:8384 whiteclaw`

## SSH Tunnel Cheat Sheet

```bash
# Syncthing GUI
ssh -L 8384:localhost:8384 whiteclaw

# Interactive session with tmux
ssh whiteclaw -t "tmux attach || tmux new"
```

## Відомі проблеми та рішення (lessons learned)

1. **ISP блокує порт 22** — SSH завжди через порт 443. Скрипти та конфіги мають це враховувати.
2. **ufw конфліктує з DO Firewall** — ufw вимкнений, файрвол тільки через DigitalOcean.
3. **CRLF на Windows** — `.gitattributes` з `*.sh text eol=lf`. При копіюванні скриптів на VM: `sed -i 's/\r$//' script.sh`.
4. **Cloud-init ненадійний** — SSH на порт 443 краще налаштовувати вручну через DO Console перед першим SSH-підключенням.
5. **Контейнер під uid 1000** — всі монтовані директорії мають `chown 1000:1000`, systemd сервіс з `UMask=0000`.
6. **agent-runner-src** — контейнер монтує `/app/src` з хоста для hot-reload. Директорія має містити копію `container/agent-runner/src/*`.
7. **GitHub через HTTPS** — ISP блокує порт 22 для git@github.com. Remote: `https://github.com/...`.
