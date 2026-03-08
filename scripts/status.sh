#!/bin/bash
# Повний статус системи WhiteClaw
# Запускати: bash scripts/status.sh
set -euo pipefail

echo "=== WhiteClaw System Status ==="
echo ""

ssh whiteclaw << 'REMOTE'
  echo "--- System ---"
  uptime
  free -h | head -2
  df -h / | tail -1
  echo ""

  echo "--- Docker ---"
  docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "Docker not running"
  echo "Images: $(docker images --format '{{.Repository}}:{{.Tag}}' | grep nanoclaw | head -3)"
  echo ""

  echo "--- NanoClaw ---"
  systemctl is-active nanoclaw 2>/dev/null || echo "not running"
  systemctl status nanoclaw --no-pager 2>/dev/null | grep -E "Active:|Memory:|CPU:" || true
  echo ""

  echo "--- Syncthing ---"
  systemctl is-active syncthing@root 2>/dev/null || echo "not running"
  echo ""

  echo "--- Shared Folder ---"
  echo "Files in inbox: $(ls /root/shared/inbox/ 2>/dev/null | wc -l)"
  echo "Files in outbox: $(ls /root/shared/outbox/ 2>/dev/null | wc -l)"
  echo ""

  echo "--- Recent Logs (last 10 lines) ---"
  tail -10 /root/nanoclaw/logs/nanoclaw.log 2>/dev/null || echo "No logs yet"
REMOTE
