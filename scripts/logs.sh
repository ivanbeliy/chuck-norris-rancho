#!/bin/bash
# Перегляд логів NanoClaw у реальному часі
# Запускати: bash scripts/logs.sh [error]
set -euo pipefail

if [ "${1:-}" = "error" ]; then
  echo "=== Error logs ==="
  ssh whiteclaw "tail -f /root/nanoclaw/logs/nanoclaw.error.log"
else
  echo "=== NanoClaw logs ==="
  ssh whiteclaw "tail -f /root/nanoclaw/logs/nanoclaw.log"
fi
