#!/bin/bash
# Налаштування VM для WhiteClaw
# Запускати: scp infra/setup-vm.sh whiteclaw:/tmp/ && ssh whiteclaw 'bash /tmp/setup-vm.sh'
set -euo pipefail

echo "=== [1/8] SSH на порт 443 (ISP може блокувати 22) ==="
# Додати порт 443 до sshd_config якщо ще не додано
if ! grep -q "^Port 443" /etc/ssh/sshd_config; then
  sed -i 's/^#Port 22/Port 22/' /etc/ssh/sshd_config
  echo "Port 443" >> /etc/ssh/sshd_config
fi
# Перезапустити SSH — це безпечно, бо поточна сесія не зірветься
mkdir -p /run/sshd
systemctl restart ssh.socket 2>/dev/null || systemctl restart ssh.service 2>/dev/null || true
echo "SSH порти: $(grep '^Port' /etc/ssh/sshd_config | tr '\n' ' ')"

echo "=== [2/8] Вимкнення ufw (файрвол через DigitalOcean) ==="
ufw disable 2>/dev/null || true
systemctl disable ufw 2>/dev/null || true

echo "=== [3/8] Оновлення системи ==="
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y

echo "=== [4/8] Встановлення базових пакетів ==="
apt-get install -y \
  curl \
  wget \
  git \
  build-essential \
  python3 \
  unzip \
  htop \
  tmux \
  jq \
  sqlite3 \
  apt-transport-https \
  ca-certificates \
  gnupg

echo "=== [5/8] Встановлення Node.js 22 ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
echo "Node.js: $(node --version)"
echo "npm: $(npm --version)"

echo "=== [6/8] Встановлення Docker ==="
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker
echo "Docker: $(docker --version)"

echo "=== [7/8] Встановлення Syncthing ==="
curl -L -o /etc/apt/keyrings/syncthing-archive-keyring.gpg \
  https://syncthing.net/release-key.gpg
echo "deb [signed-by=/etc/apt/keyrings/syncthing-archive-keyring.gpg] https://apt.syncthing.net/ syncthing stable" \
  > /etc/apt/sources.list.d/syncthing.list
apt-get update
apt-get install -y syncthing

# Створити директорії
mkdir -p /root/shared/{inbox,outbox,projects}
mkdir -p /root/projects
mkdir -p /root/.config/nanoclaw

# Згенерувати конфіг Syncthing
syncthing generate --config=/root/.config/syncthing

# Відкрити GUI на всіх інтерфейсах для початкового парування
# ВАЖЛИВО: після парування обмежити до localhost (див. RUNBOOK)
sed -i 's|<address>127.0.0.1:8384</address>|<address>0.0.0.0:8384</address>|' \
  /root/.config/syncthing/config.xml

# Створити .stignore для shared
cat > /root/shared/.stignore << 'STIGNORE'
node_modules
.git
__pycache__
*.pyc
dist
build
.next
.cache
.venv
venv
STIGNORE

# Systemd сервіс для Syncthing
cat > /etc/systemd/system/syncthing@.service << 'EOF'
[Unit]
Description=Syncthing - Open Source Continuous File Synchronization for %I
Documentation=man:syncthing(1)
After=network.target

[Service]
User=%i
ExecStart=/usr/bin/syncthing serve --no-browser --no-restart
Restart=on-failure
RestartSec=5
SuccessExitStatus=3 4
RestartForceExitStatus=3 4

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable syncthing@root
systemctl start syncthing@root

echo "=== [8/8] Встановлення Claude Code CLI ==="
npm install -g @anthropic-ai/claude-code
echo "Claude Code: $(claude --version 2>/dev/null || echo 'installed')"

# Створити робочі директорії
mkdir -p /root/nanoclaw
mkdir -p /root/nanoclaw/logs

echo ""
echo "=========================================="
echo "  VM готова!"
echo "=========================================="
echo ""
echo "SSH порти: $(grep '^Port' /etc/ssh/sshd_config | tr '\n' ' ')"
echo ""
echo "Syncthing Device ID:"
syncthing -device-id 2>/dev/null || syncthing --device-id 2>/dev/null || echo "(запустіть syncthing -device-id окремо)"
echo ""
echo "Syncthing GUI (тимчасово відкритий):"
echo "  http://$(curl -s ifconfig.me):8384"
echo ""
echo "ВАЖЛИВО: Після парування Syncthing обмежте GUI:"
echo "  sed -i 's|0.0.0.0:8384|127.0.0.1:8384|' /root/.config/syncthing/config.xml"
echo "  systemctl restart syncthing@root"
echo "  (потім доступ через SSH тунель: ssh -L 8384:localhost:8384 whiteclaw)"
echo ""
echo "Наступні кроки:"
echo "1. Спарити Syncthing з Windows (Device ID вище)"
echo "2. git clone https://github.com/qwibitai/nanoclaw.git /root/nanoclaw"
echo "3. cd /root/nanoclaw && npm install && npm run build"
echo "4. claude setup-token"
echo "5. Створити .env (див. config/nanoclaw.env у репо WhiteClaw)"
echo "6. claude → /setup"
