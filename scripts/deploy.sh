#!/bin/bash
# Перезавантаження NanoClaw після оновлень
# Запускати з Windows: bash scripts/deploy.sh
set -euo pipefail

echo "=== Deploying NanoClaw ==="

ssh whiteclaw << 'REMOTE'
  set -euo pipefail
  cd /root/nanoclaw

  echo "Pulling latest changes..."
  git pull

  echo "Installing dependencies..."
  npm install

  echo "Building..."
  npm run build

  echo "Rebuilding container image..."
  ./container/build.sh

  echo "Restarting service..."
  systemctl restart nanoclaw

  echo ""
  echo "=== Deploy complete ==="
  systemctl status nanoclaw --no-pager | head -10
REMOTE
