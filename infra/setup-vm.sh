#!/bin/bash
# Налаштування VM для WhiteClaw
# Запускати: ssh whiteclaw 'bash -s' < infra/setup-vm.sh
set -euo pipefail

echo "=== [1/7] Оновлення системи ==="
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y

echo "=== [2/7] Встановлення базових пакетів ==="
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
  ufw \
  apt-transport-https \
  ca-certificates \
  gnupg

echo "=== [3/7] Встановлення Node.js 22 ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
echo "Node.js: $(node --version)"
echo "npm: $(npm --version)"

echo "=== [4/7] Встановлення Docker ==="
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker
echo "Docker: $(docker --version)"

echo "=== [5/7] Встановлення Syncthing ==="
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
# ВАЖЛИВО: після парування обмежити до localhost (див. нижче)
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

echo "=== [6/7] Встановлення Claude Code CLI ==="
npm install -g @anthropic-ai/claude-code
echo "Claude Code: $(claude --version 2>/dev/null || echo 'installed')"

echo "=== [7/7] Створення робочих директорій ==="
mkdir -p /root/nanoclaw
mkdir -p /root/whiteclaw-config

echo ""
echo "=========================================="
echo "  VM готова!"
echo "=========================================="
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
echo "2. Форкнути nanoclaw: gh repo fork qwibitai/nanoclaw --clone --remote"
echo "   або: git clone https://github.com/ivanbeliy/nanoclaw.git /root/nanoclaw"
echo "3. cd /root/nanoclaw && npm install"
echo "4. claude setup-token"
echo "5. Створити .env (див. config/nanoclaw.env у репо WhiteClaw)"
echo "6. claude → /setup"
